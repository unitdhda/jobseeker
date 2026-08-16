import type { ThinkingLevel } from '@earendil-works/pi-ai';
import {
  drainScoring,
  type DiscoveryPorts,
  type DiscoveryReport,
  type JudgmentPorts,
  type LoopPorts,
  type NormalizeReport,
  type ScoreDueReport,
} from '@jobseeker/engine/loop';
import { mapConcurrent, type AdaptiveTaskPool } from '@jobseeker/engine/concurrency';
import { matchVacancy, runSchedulerTick, type MatchCandidateInput, type TickReport } from '@jobseeker/engine/runtime';
import { prefilterVacancy, parseStoredCareerProfile, type CareerProfile } from '@jobseeker/engine/prefilter';
import type { CvContentHash, UserId, VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { MutableSources } from '@jobseeker/sources';
import type { PendingMatch, TelegramUser, Vacancy } from '@jobseeker/store';
import type { JsonModels } from './ai.ts';
import type { AppConfig, ModelId } from './config.ts';
import type { MatchingVocabularies } from './matching-vocabularies.ts';
import { prescorePendingVacancies, scorePendingVacancies, type ScoringWorkflowPorts } from './workflows.ts';

export interface NormalizationPorts {
  approvedUsers(requireCv?: boolean): Promise<readonly TelegramUser[]>;
  queuedListings(limit: number, perSourceLimit: number, claimLeaseMinutes: number): Promise<readonly VacancyCandidate[]>;
  candidatesDueForRefresh(limit: number, days: number): Promise<readonly VacancyCandidate[]>;
  upsertVacancy(input: VacancyInput): Promise<{ readonly id: number; readonly needsScore: boolean; readonly duplicate: boolean }>;
  markCandidateNormalized(candidate: VacancyCandidate, vacancyId: number, duplicate?: boolean): Promise<void>;
  markCandidateClosed(candidate: VacancyCandidate): Promise<void>;
  markCandidateFailed(candidate: VacancyCandidate, error: string): Promise<void>;
  markCandidateRefreshFailed(candidate: VacancyCandidate, error: string): Promise<void>;
  purgeExpiredVacancies(retentionDays: number, limit: number): Promise<number>;
}

function groupCandidates(candidates: readonly VacancyCandidate[]): Map<string, VacancyCandidate[]> {
  const groups = new Map<string, VacancyCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.source) ?? []; group.push(candidate); groups.set(candidate.source, group);
  }
  return groups;
}

export function createNormalizationAdapter(input: {
  readonly store: NormalizationPorts;
  readonly sources: Pick<MutableSources, 'normalize'>;
  readonly config: Pick<AppConfig, 'normalizationBatchSizePerUser' | 'normalizationPerSourceLimit'
    | 'normalizationClaimLeaseMinutes' | 'normalizeSourceConcurrency' | 'candidateRefreshBatchSize'
    | 'candidateRefreshDays' | 'vacancyRetentionDays' | 'vacancyPurgeBatchSize'>;
  readonly errorMessage?: (error: unknown) => string;
}): (now: Date) => Promise<NormalizeReport> {
  const errorMessage = input.errorMessage ?? ((error) => error instanceof Error ? error.message : 'Normalization failed.');
  return async (_now) => {
    const users = await input.store.approvedUsers(true);
    const queueLimit = users.length * input.config.normalizationBatchSizePerUser;
    const [queued, refresh] = await Promise.all([
      queueLimit > 0 ? input.store.queuedListings(queueLimit,
        Math.min(queueLimit, input.config.normalizationPerSourceLimit), input.config.normalizationClaimLeaseMinutes) : Promise.resolve([]),
      input.store.candidatesDueForRefresh(input.config.candidateRefreshBatchSize, input.config.candidateRefreshDays),
    ]);
    const refreshKeys = new Set(refresh.map((candidate) => `${candidate.source.length}:${candidate.source}:${candidate.sourceId}`));
    const candidates = [...queued, ...refresh];
    const bySource = groupCandidates(candidates);
    const vacancyIds = new Set<number>(); let failed = 0; let closed = 0; let normalized = 0;
    await mapConcurrent([...bySource.entries()], input.config.normalizeSourceConcurrency, async ([source, group]) => {
      for (const candidate of group) {
        const key = `${candidate.source.length}:${candidate.source}:${candidate.sourceId}`;
        const isRefresh = refreshKeys.has(key);
        let result: VacancyInput | null | Error;
        try {
          const results = await input.sources.normalize(source, [candidate]);
          result = results.has(candidate.sourceId) ? results.get(candidate.sourceId)!
            : new Error('Source omitted normalization result.');
        } catch (error) {
          result = error instanceof Error ? error : new Error(errorMessage(error));
        }
        if (result === null) {
          closed += 1; await input.store.markCandidateClosed(candidate); continue;
        }
        if (result instanceof Error) {
          failed += 1;
          if (isRefresh) await input.store.markCandidateRefreshFailed(candidate, errorMessage(result).slice(0, 500));
          else await input.store.markCandidateFailed(candidate, errorMessage(result).slice(0, 500));
          continue;
        }
        try {
          const stored = await input.store.upsertVacancy(result); normalized += 1;
          if (!isRefresh) await input.store.markCandidateNormalized(candidate, stored.id, stored.duplicate);
          if (stored.needsScore && !stored.duplicate) vacancyIds.add(stored.id);
        } catch (error) {
          failed += 1;
          if (isRefresh) await input.store.markCandidateRefreshFailed(candidate, errorMessage(error).slice(0, 500));
          else await input.store.markCandidateFailed(candidate, errorMessage(error).slice(0, 500));
        }
      }
    });
    const expired = await input.store.purgeExpiredVacancies(input.config.vacancyRetentionDays, input.config.vacancyPurgeBatchSize);
    return Object.freeze({ vacancyIds: Object.freeze([...vacancyIds].sort((a, b) => a - b)), failed, closed, expired,
      selected: queued.length, refreshed: refresh.length, normalized,
      bySource: Object.freeze(Object.fromEntries([...bySource].map(([source, values]) => [source, values.length]))) });
  };
}

interface Lens { readonly userId: UserId; readonly cvText: string; readonly profile: CareerProfile }
export interface MatchingPorts {
  approvedUsers(requireCv?: boolean): Promise<readonly TelegramUser[]>;
  getCvSource(userId: UserId): Promise<{ readonly hash: CvContentHash; readonly text: string } | null>;
  getCareerProfile<TResult>(userId: UserId): Promise<TResult | null>;
  getVacancy(id: number): Promise<Vacancy | null>;
  createMatches(candidates: readonly MatchCandidateInput[], now: Date): Promise<number>;
}

export function createMatchingAdapter(input: {
  readonly store: MatchingPorts;
  readonly vocabularies: MatchingVocabularies;
  readonly minimumScore: number;
  readonly maximumAgeDays: number;
}): DiscoveryPorts['matchVacancies'] {
  return async (vacancyIds, now) => {
    const users = await input.store.approvedUsers(true); const lenses: Lens[] = []; let failures = 0;
    for (const user of users) {
      try {
        const cv = await input.store.getCvSource(user.userId); if (!cv) { failures += 1; continue; }
        const stored = await input.store.getCareerProfile<unknown>(user.userId);
        const profile = parseStoredCareerProfile(stored, cv.hash).profile;
        lenses.push(Object.freeze({ userId: user.userId, cvText: cv.text, profile }));
      } catch { failures += 1; }
    }
    const vocabularies = input.vocabularies.snapshot(); let matched = 0;
    for (const vacancyId of vacancyIds) {
      const vacancy = await input.store.getVacancy(vacancyId);
      if (!vacancy) { failures += 1; continue; }
      const report = await matchVacancy({
        approvedUserIds: async () => Object.freeze(lenses.map((lens) => lens.userId)),
        lexicalScore: async (userId) => {
          const lens = lenses.find((value) => value.userId === userId)!;
          const evidence = prefilterVacancy(lens.cvText, vacancy, { profile: lens.profile, minimumScore: input.minimumScore,
            maxAgeDays: input.maximumAgeDays, now, roleResolver: vocabularies.roleResolver, idfLookups: vocabularies.idfLookups });
          return evidence.filtered ? null : { score: evidence.combinedScore, regexScore: evidence.regexScore,
            lexicalCosine: evidence.lexicalCosine, titleSimilarity: evidence.titleSimilarity, skillCoverage: evidence.skillCoverage,
            seniorityGap: evidence.seniorityGap, specificity: evidence.specificity, lexicalCosineIdf: evidence.lexicalCosineIdf };
        },
        matchFloor: input.minimumScore,
        createMatches: input.store.createMatches,
      }, { vacancyId }, now);
      matched += report.matched; failures += report.failures;
    }
    return Object.freeze({ matched, failures });
  };
}

export interface ScoringAdapterOptions {
  readonly store: ScoringWorkflowPorts & {
    approvedUsers(requireCv?: boolean): Promise<readonly TelegramUser[]>;
    spentToday(userId: UserId, day: string): Promise<number>;
  };
  readonly models: JsonModels;
  readonly pool: Pick<AdaptiveTaskPool, 'run'>;
  readonly config: Pick<AppConfig, 'prescoringModel' | 'prescoringThinking' | 'prescorePromptVersion' | 'prescoreMinScore'
    | 'prescoreExplorationRate' | 'prescoreBatchSize' | 'prescoreLimitPerCycle' | 'scoringModel' | 'scoringThinking'
    | 'scoringFallbackModel' | 'scoringFallbackThinking' | 'scoreBatchSize' | 'scoringBatchTimeoutMs'
    | 'scoringBatchMaxAttempts' | 'userDailyLlmBudgetUsd'>;
  readonly terminalUsageLimit?: (error: unknown) => boolean;
  readonly errorMessage?: (error: unknown) => string;
}
function utcDay(now: Date): string { return now.toISOString().slice(0, 10); }

export function createScoringAdapter(options: ScoringAdapterOptions): (claimLimit: number, now: Date) => Promise<ScoreDueReport> {
  return (claimLimit, now) => drainScoring({
    scoringUserIds: async () => Object.freeze((await options.store.approvedUsers(true)).map((user) => user.userId)),
    spentTodayUsd: (userId, date) => options.store.spentToday(userId, utcDay(date)),
    drainUser: async (userId, limit) => {
      let attempted = 0; let completed = 0;
      if (options.config.prescoringModel) {
        const report = await prescorePendingVacancies({ userId, models: options.models, model: options.config.prescoringModel,
          thinking: options.config.prescoringThinking, promptVersion: options.config.prescorePromptVersion,
          threshold: options.config.prescoreMinScore, explorationRate: options.config.prescoreExplorationRate,
          batchSize: options.config.prescoreBatchSize, cycleCap: options.config.prescoreLimitPerCycle,
          ports: options.store, errorMessage: options.errorMessage });
        attempted += report.claimed; completed += report.saved;
      }
      const report = await scorePendingVacancies({ userId, models: options.models, model: options.config.scoringModel,
        thinking: options.config.scoringThinking, fallbackModel: options.config.scoringFallbackModel,
        fallbackThinking: options.config.scoringFallbackThinking, prescoreModel: options.config.prescoringModel,
        prescorePromptVersion: options.config.prescorePromptVersion, prescoreThreshold: options.config.prescoreMinScore,
        cycleCap: limit, batchSize: options.config.scoreBatchSize, timeoutMs: options.config.scoringBatchTimeoutMs,
        maxAttempts: options.config.scoringBatchMaxAttempts, pool: options.pool, ports: options.store,
        terminalUsageLimit: options.terminalUsageLimit, errorMessage: options.errorMessage });
      attempted += report.claimed; completed += report.saved;
      return { attempted, completed };
    },
  }, { dailyBudgetUsd: options.config.userDailyLlmBudgetUsd, claimLimit }, now);
}

export function createMaintenanceAdapter(input: {
  readonly expireStaleMatches: (maximumAgeDays: number, now: Date) => Promise<number>;
  readonly maximumAgeDays: number;
  readonly vocabularies: Pick<MatchingVocabularies, 'rebuild'>;
  readonly initialNow?: Date;
}): Pick<JudgmentPorts, 'retire' | 'maintain'> {
  let retiredHour: string | null = null;
  let vocabularyDay = (input.initialNow ?? new Date()).toISOString().slice(0, 10);
  return Object.freeze({
    retire: async (now) => {
      const hour = now.toISOString().slice(0, 13);
      if (hour === retiredHour) return 0;
      const count = await input.expireStaleMatches(input.maximumAgeDays, now); retiredHour = hour; return count;
    },
    maintain: async (now) => {
      const day = now.toISOString().slice(0, 10);
      if (day === vocabularyDay) return;
      await input.vocabularies.rebuild(); vocabularyDay = day;
    },
  });
}

export function discoveryTickLog(report: DiscoveryReport): string | null {
  if (!report.tick) return null;
  const failed = report.tick.failedPlatforms.join(',') || 'none';
  return `Discovery tick: due=${report.tick.due} run=${report.tick.unitsRun} failed=${failed}.`;
}

export function createEnginePorts(input: {
  readonly store: NormalizationPorts & MatchingPorts & ScoringAdapterOptions['store'] & {
    dueUnits: Parameters<typeof runSchedulerTick>[0]['dueUnits'];
    recordUnitRun: Parameters<typeof runSchedulerTick>[0]['recordUnitRun'];
    expireStaleMatches(maximumAgeDays: number, now: Date): Promise<number>;
  };
  readonly sources: MutableSources;
  readonly vocabularies: MatchingVocabularies;
  readonly models: JsonModels;
  readonly scorePool: Pick<AdaptiveTaskPool, 'run'>;
  readonly config: AppConfig;
  readonly deliver: (now: Date) => Promise<void>;
  readonly errorMessage?: (error: unknown) => string;
  readonly log?: (message: string) => void;
}): LoopPorts {
  const normalize = createNormalizationAdapter({ store: input.store, sources: input.sources, config: input.config,
    errorMessage: input.errorMessage });
  const matchVacancies = createMatchingAdapter({ store: input.store, vocabularies: input.vocabularies,
    minimumScore: input.config.prefilterMinScore, maximumAgeDays: input.config.prefilterMaxAgeDays });
  const score = createScoringAdapter({ store: input.store, models: input.models, pool: input.scorePool, config: input.config,
    errorMessage: input.errorMessage });
  const maintenance = createMaintenanceAdapter({ expireStaleMatches: input.store.expireStaleMatches,
    maximumAgeDays: input.config.prefilterMaxAgeDays, vocabularies: input.vocabularies });
  return Object.freeze({
    tick: (now: Date) => runSchedulerTick({ cadencePolicy: { floorMinutes: input.config.unitCadenceFloorMinutes,
      ceilingMinutes: input.config.unitCadenceCeilingMinutes }, queriesPerUserPerTick: input.config.searchQueriesPerCycle,
      platformConcurrency: input.config.discoveryTickConcurrency, dueUnits: input.store.dueUnits,
      discover: (platform, plan) => input.sources.discover(platform, plan), recordUnitRun: input.store.recordUnitRun }, now),
    normalize, matchVacancies,
    scoreDue: (now: Date) => score(input.config.userScoreLimitPerCycle, now),
    deliver: input.deliver,
    observeDiscovery: (report: DiscoveryReport) => {
      const message = discoveryTickLog(report); if (message) input.log?.(message);
    },
    ...maintenance,
  });
}
