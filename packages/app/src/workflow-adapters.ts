import type { Models, Usage } from '@earendil-works/pi-ai';
import { prefilterVacancy, parseStoredCareerProfile } from '@jobseeker/engine/prefilter';
import type { MatchCandidateInput } from '@jobseeker/engine/runtime';
import type { CvContentHash, UserId } from '@jobseeker/engine/contracts';
import type { CompiledDemand, NamedSearch } from '@jobseeker/engine/subscribe';
import type { AnySourceProvider } from '@jobseeker/sources';
import type { ApplicationArtifact, Store } from '@jobseeker/store';
import { tailorApplication, type ApplicationPorts, type ApplicationRenderer } from './application.ts';
import type { ApplicationComposition } from './composition.ts';
import type { AppConfig } from './config.ts';
import type { MatchingVocabularies } from './matching-vocabularies.ts';
import { refreshUserProfiles, type ProfileRefreshPorts } from './profile-refresh.ts';
import type { ScoringWorkflowPorts } from './workflows.ts';
import type { JobWorkerHandlers } from './worker.ts';

export function llmUsageInput(usage: Usage) {
  return { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite, totalTokens: usage.totalTokens, costUsd: usage.cost.total };
}
async function recordLlm(store: Store, userId: UserId, agent: string, model: string, usage: Usage): Promise<void> {
  await store.recordLlmUsageEvent(userId, agent, model, llmUsageInput(usage));
}

async function reserveProfile(store: Store, config: AppConfig, userId: UserId, agent: string): Promise<void> {
  const used = await store.usageInLast24Hours(userId, 'search-profile');
  if (used >= config.userDailySearchProfileLimit) throw new Error('Daily search-profile limit reached.');
  await store.recordUsage(userId, 'search-profile', agent);
}

export function createProfileRefreshPorts(input: {
  readonly store: Store;
  readonly config: AppConfig;
  readonly vocabularies: MatchingVocabularies;
  readonly backfillBatchSize?: number;
}): ProfileRefreshPorts {
  const batchSize = input.backfillBatchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new RangeError('Invalid profile backfill batch size.');
  const backfillRecentStock = async (userId: UserId): Promise<void> => {
    const cv = await input.store.getCvSource(userId); if (!cv) return;
    const stored = await input.store.getCareerProfile<unknown>(userId);
    const profile = parseStoredCareerProfile(stored, cv.hash).profile;
    const vocabulary = input.vocabularies.snapshot(); let afterId = 0;
    for (;;) {
      const ids = await input.store.recentNormalizedVacancyIds(afterId, batchSize, input.config.prefilterMaxAgeDays);
      if (ids.length === 0) break;
      const candidates: MatchCandidateInput[] = [];
      for (const vacancyId of ids) {
        afterId = vacancyId;
        const vacancy = await input.store.getVacancy(vacancyId); if (!vacancy) continue;
        const evidence = prefilterVacancy(cv.text, vacancy, { profile, minimumScore: input.config.prefilterMinScore,
          maxAgeDays: input.config.prefilterMaxAgeDays, roleResolver: vocabulary.roleResolver,
          idfLookups: vocabulary.idfLookups });
        if (!evidence.filtered) candidates.push(Object.freeze({ userId, vacancyId, score: evidence.combinedScore,
          regexScore: evidence.regexScore, lexicalCosine: evidence.lexicalCosine, titleSimilarity: evidence.titleSimilarity,
          skillCoverage: evidence.skillCoverage, seniorityGap: evidence.seniorityGap, specificity: evidence.specificity,
          lexicalCosineIdf: evidence.lexicalCosineIdf }));
      }
      if (candidates.length) await input.store.createMatches(candidates, new Date());
      if (ids.length < batchSize) break;
    }
  };
  return Object.freeze({
    getCvSource: input.store.getCvSource,
    getCvHash: input.store.getCvHash,
    saveCareerProfile: input.store.saveCareerProfile,
    getSearchProfile: input.store.getSearchProfile,
    saveSearchProfile: input.store.saveSearchProfile,
    activeUnitQueries: input.store.activeUnitQueries,
    existingCompiledUnits: async () => await input.store.existingCompiledUnits() as unknown as Awaited<ReturnType<ProfileRefreshPorts['existingCompiledUnits']>>,
    applyDemand: (userId: UserId, demand: CompiledDemand<NamedSearch>, cadence: number) =>
      input.store.applyDemand(userId, demand.units, demand.subscriptions, cadence),
    reserveProfileUsage: (userId: UserId, agent: string) => reserveProfile(input.store, input.config, userId, agent),
    recordLlmUsage: (userId: UserId, agent: string, model: string, usage: Usage) =>
      recordLlm(input.store, userId, agent, model, usage),
    refreshRoleEquivalences: async () => { await input.vocabularies.refreshEquivalences(); },
    backfillRecentStock,
  });
}

export function createScoringWorkflowPorts(store: Store): ScoringWorkflowPorts & {
  approvedUsers: Store['approvedUsers']; spentToday: Store['spentToday'];
} {
  return Object.freeze({
    getCvSource: store.getCvSource,
    pendingMatchesForPrescoring: store.pendingMatchesForPrescoring,
    pendingMatchesForScoring: store.pendingMatchesForScoring,
    claimMatches: store.claimMatches,
    releaseMatchClaims: store.releaseMatchClaims,
    getVacancy: store.getVacancy,
    savePrescore: store.savePrescore,
    saveScore: store.saveScore,
    savedScoreVacancyIds: store.savedScoreVacancyIds,
    reserveScoreUsage: (userId: UserId, vacancyId: number) => store.recordUsage(userId, 'score', `vacancy:${vacancyId}`),
    recordLlmUsage: (userId: UserId, agent: string, model: string, usage: Usage) => recordLlm(store, userId, agent, model, usage),
    addScoreSpend: (userId: UserId, costUsd: number) =>
      store.addSpend(userId, new Date().toISOString().slice(0, 10), costUsd, 'scores'),
    approvedUsers: store.approvedUsers,
    spentToday: store.spentToday,
  });
}

const applicationAgent = { cv: 'tailor-application', letter: 'tailor-cover-letter' } as const;
async function reserveApplication(store: Store, config: AppConfig, userId: UserId, artifact: ApplicationArtifact): Promise<void> {
  const agent = applicationAgent[artifact];
  const used = await store.usageInLast24Hours(userId, 'application', agent);
  const maximum = artifact === 'cv' ? config.userDailyApplicationLimit : config.userDailyCoverLetterLimit;
  if (used >= maximum) throw new Error(`Daily ${artifact === 'cv' ? 'tailored-CV' : 'cover-letter'} limit reached.`);
}
export function createApplicationPorts(store: Store, config: AppConfig): ApplicationPorts {
  return Object.freeze({
    getCvSource: store.getCvSource,
    getCvHash: store.getCvHash,
    getVacancy: store.getVacancy,
    deliveredArtifact: store.deliveredArtifact,
    reserveApplicationUsage: (userId: UserId, artifact: ApplicationArtifact) =>
      reserveApplication(store, config, userId, artifact),
    beginApplication: store.beginApplication,
    markApplicationReady: store.markApplicationReady,
    failApplication: store.failApplication,
    recordLlmUsage: (userId: UserId, agent: string, model: string, usage: Usage) =>
      recordLlm(store, userId, agent, model, usage),
  });
}

export function createJobWorkerHandlers(input: {
  readonly composition: Pick<ApplicationComposition, 'config' | 'store' | 'sources' | 'ai' | 'enabledSourceProviderIds'>;
  readonly vocabularies: MatchingVocabularies;
  readonly renderer: ApplicationRenderer;
  readonly errorMessage?: (error: unknown) => string;
}): JobWorkerHandlers {
  const providers = input.composition.enabledSourceProviderIds.map((id) => input.composition.sources.getProvider(id))
    .filter((provider): provider is AnySourceProvider => provider !== undefined);
  const profilePorts = createProfileRefreshPorts({ store: input.composition.store, config: input.composition.config,
    vocabularies: input.vocabularies });
  const applicationPorts = createApplicationPorts(input.composition.store, input.composition.config);
  return Object.freeze({
    getCvHash: input.composition.store.getCvHash,
    refreshUser: (userId: UserId, _cvHash: CvContentHash) => refreshUserProfiles({ userId, providers, models: input.composition.ai as Models,
      model: input.composition.config.generationModel, thinking: input.composition.config.generationThinking,
      clusterSimilarity: input.composition.config.searchClusterSimilarity,
      initialCadenceMinutes: input.composition.config.unitCadenceFloorMinutes, ports: profilePorts,
      errorMessage: input.errorMessage }),
    tailorApplication: (userId: UserId, vacancyId: number, artifact: ApplicationArtifact) => tailorApplication({ userId, vacancyId, artifact,
      models: input.composition.ai as Models, model: input.composition.config.generationModel,
      thinking: input.composition.config.generationThinking, ports: applicationPorts,
      ...(artifact === 'cv' ? { renderer: input.renderer } : {}), errorMessage: input.errorMessage }),
  });
}
