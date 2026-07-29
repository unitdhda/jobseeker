import { createHash } from 'node:crypto';
import { init } from '@flue/runtime';
import { PrepareSearchProfile, ScoreVacancy, TailorApplication } from '../agents/workflows.ts';
import { config } from '../config.ts';
import {
  beginApplication, failApplication, getCvBundleHash, getCvTemplate, getScoredVacancy, getSearchProfile, getVacancy,
  pendingVacancies, prefilterCalibration, prefilterQueueStats, rankedPendingVacancies, recordUsage, requireApprovedUser,
  savePrefilterScore, usageInLast24Hours, vacanciesNeedingPrefilter, type Vacancy,
} from './database.ts';
import { getSearchPlatform } from '../platforms/registry.ts';
import * as v from 'valibot';
import { clearApplicationArtifacts, getApplicationArtifacts, type GeneratedApplication } from './application-artifacts.ts';
import { detectCvLanguage } from './language.ts';
import { trace } from './trace.ts';
import { prefilterVacancy, vacancySemanticText } from './prefilter.ts';
import { embeddingCosine, semanticEmbedding } from './semantic-embeddings.ts';
import { errorMessage } from './logging.ts';
import { adaptiveConcurrency, AdaptiveTaskPool } from './adaptive-concurrency.ts';

const scoringPool = new AdaptiveTaskPool(config.scoreAgentConcurrencyMin, config.scoreAgentConcurrencyMax);

export async function ensureCvAndSearchProfiles(userId: string, force = false,
  expectedCvHash?: string): Promise<Record<string, unknown>> {
  requireApprovedUser(userId);
  const ru = getCvTemplate(userId, 'ru');
  const en = getCvTemplate(userId, 'en');
  if (!ru || !en) throw new Error('Upload both Russian and English CV templates with /cv first.');
  const hash = getCvBundleHash(userId);
  if (!hash || (expectedCvHash && hash !== expectedCvHash)) throw new Error('CV changed before profile generation started.');
  const profiles: Record<string, unknown> = {};

  for (const platformId of config.searchPlatforms) {
    requireApprovedUser(userId);
    if (getCvBundleHash(userId) !== hash) throw new Error('CV changed during profile generation.');
    const platform = getSearchPlatform(platformId);
    try {
      if (force || !getSearchProfile(userId, platformId)) {
        if (usageInLast24Hours(userId, 'search-profile') >= config.userDailySearchProfileLimit) {
          throw new Error(`Daily search-profile limit (${config.userDailySearchProfileLimit}) reached.`);
        }
        trace('search_profile.agent.start', { userId, platform: platformId, force });
        const agent = init(PrepareSearchProfile, { id: `${userId}-${platformId}-search-v2-${hash.slice(0, 16)}` });
        recordUsage(userId, 'search-profile');
        const receipt = await agent.dispatch({
          initialData: { userId, platformId, cvHash: hash },
          message: {
            kind: 'signal',
            type: 'cv.prepare-search',
            body: `Build the ${platform.name} search profile.\n\nRUSSIAN CV TEMPLATE:\n${ru.cvText}\n\nENGLISH CV TEMPLATE:\n${en.cvText}`,
          },
        });
        await agent.read(receipt);
        trace('search_profile.agent.completed', { platform: platformId });
      }

      const result = v.safeParse(platform.schema, getSearchProfile<unknown>(userId, platformId));
      if (!result.success) throw new Error(`Search-profile agent did not save a valid ${platform.name} profile.`);
      profiles[platformId] = result.output;
      trace('search_profile.ready', { platform: platformId, profile: result.output });
    } catch (error) {
      console.error(`Failed to prepare ${platform.name} search profile: ${errorMessage(error)}`);
    }
  }
  return profiles;
}

export async function scoreOne(userId: string, vacancyId: number): Promise<void> {
  requireApprovedUser(userId);
  if (usageInLast24Hours(userId, 'score') >= config.userDailyScoreLimit) {
    throw new Error(`Daily vacancy-scoring limit (${config.userDailyScoreLimit}) reached.`);
  }
  const vacancy = getVacancy(vacancyId);
  if (!vacancy) throw new Error(`Vacancy ${vacancyId} was not found.`);
  trace('scoring.agent.start', { vacancyId, source: vacancy.source, sourceId: vacancy.sourceId,
    name: vacancy.name, employer: vacancy.employer, contentHash: vacancy.contentHash });
  const agent = init(ScoreVacancy, { id: `${userId}-vacancy-${vacancyId}-${vacancy.contentHash.slice(0, 12)}` });
  recordUsage(userId, 'score');
  const receipt = await agent.dispatch({
    initialData: { userId, vacancyId },
    message: { kind: 'signal', type: 'vacancy.score', body: 'Load and score this vacancy now.' },
  });
  await agent.read(receipt);
  trace('scoring.agent.completed', { vacancyId });
}

export async function scorePendingVacancies(
  userId: string,
  afterScore?: (vacancyId: number) => Promise<void>,
  progress?: (phase: 'filtering' | 'scoring', current: number, total: number) => void,
  scoreLimit = config.scoreBatchSize,
): Promise<number> {
  let vacancies: Vacancy[];
  let calibrationContext: string | undefined;
  if (config.prefilterEnabled) {
    const ru = getCvTemplate(userId, 'ru');
    const en = getCvTemplate(userId, 'en');
    if (!ru || !en) throw new Error('Both CV templates are required for pre-LLM filtering.');
    const cvText = `${ru.cvText}\n\n${en.cvText}`;
    const cvContentHash = createHash('sha256').update(cvText).digest('hex');
    const contextHash = createHash('sha256').update([
      'prefilter-v3-score-only', cvContentHash, config.prefilterMinScore,
      config.semanticPrefilterEnabled, config.semanticEmbeddingModel, config.semanticEmbeddingDtype,
      config.prefilterAuditPercent,
    ].join(':')).digest('hex');
    calibrationContext = contextHash;
    const candidates = vacanciesNeedingPrefilter(userId, contextHash, config.prefilterBatchSize, config.semanticPrefilterEnabled);
    trace('prefilter.batch.start', { contextHash: contextHash.slice(0, 12), candidates: candidates.length,
      minimumScore: config.prefilterMinScore,
      semanticEnabled: config.semanticPrefilterEnabled, auditPercent: config.prefilterAuditPercent });
    let cvVector: Float32Array | undefined;
    if (config.semanticPrefilterEnabled && candidates.length) {
      try {
        cvVector = await semanticEmbedding('cv', cvContentHash, cvText, userId);
      } catch (error) {
        console.warn(`Semantic prefilter unavailable; falling back to lexical scoring: ${errorMessage(error)}`);
      }
    }
    progress?.('filtering', 0, candidates.length);
    for (const [index, vacancy] of candidates.entries()) {
      const lexical = prefilterVacancy(cvText, vacancy, config.prefilterMinScore);
      let semanticCosine: number | null = null;
      let semanticStatus: 'ready' | 'skipped' | 'disabled' | 'unavailable' = config.semanticPrefilterEnabled
        ? 'unavailable' : 'disabled';
      if (cvVector) {
        try {
          const vacancyVector = await semanticEmbedding('vacancy', vacancy.contentHash, vacancySemanticText(vacancy));
          semanticCosine = embeddingCosine(cvVector, vacancyVector);
          semanticStatus = 'ready';
        } catch (error) {
          console.warn(`Semantic embedding failed for vacancy ${vacancy.id}; using lexical score: ${errorMessage(error)}`);
        }
      }
      const result = semanticCosine == null ? lexical
        : prefilterVacancy(cvText, vacancy, config.prefilterMinScore, semanticCosine);
      const auditDigest = createHash('sha256').update(`${contextHash}:${vacancy.id}`).digest().readUInt32BE(0);
      const auditSelected = result.filtered && auditDigest / 0x1_0000_0000 * 100 < config.prefilterAuditPercent;
      savePrefilterScore(userId, vacancy.id, contextHash, vacancy.contentHash, { ...result, semanticStatus, auditSelected });
      trace('prefilter.vacancy.scored', { vacancyId: vacancy.id, source: vacancy.source, name: vacancy.name,
        semanticStatus, auditSelected, ...result });
      progress?.('filtering', index + 1, candidates.length);
    }
    const stats = prefilterQueueStats(userId, contextHash);
    const ranked = rankedPendingVacancies(userId, contextHash, scoreLimit, Math.min(config.prefilterAuditSlots, scoreLimit));
    vacancies = ranked;
    trace('prefilter.queue.ranked', { ...stats, selected: ranked.map((vacancy) => ({
      vacancyId: vacancy.id, source: vacancy.source, name: vacancy.name, prefilterScore: vacancy.prefilterScore,
      auditSelected: vacancy.auditSelected,
    })) });
  } else {
    vacancies = pendingVacancies(userId, scoreLimit);
  }
  progress?.('scoring', 0, vacancies.length);
  trace('scoring.parallel.start', {
    vacancies: vacancies.length,
    localConcurrency: adaptiveConcurrency(vacancies.length, config.scoreAgentConcurrencyMin, config.scoreAgentConcurrencyMax),
    poolActive: scoringPool.activeCount,
    poolQueued: scoringPool.queuedCount,
  });
  let completed = 0;
  await Promise.all(vacancies.map((vacancy) => scoringPool.run(async () => {
    try {
      await scoreOne(userId, vacancy.id);
      await afterScore?.(vacancy.id);
    } catch (error) {
      console.error(`Failed to score vacancy ${vacancy.id}: ${errorMessage(error)}`);
    } finally {
      completed++;
      progress?.('scoring', completed, vacancies.length);
    }
  })));
  trace('scoring.parallel.completed', { vacancies: vacancies.length });
  if (calibrationContext) {
    trace('prefilter.calibration', prefilterCalibration(userId, calibrationContext, config.alertScore,
      config.prefilterCalibrationMinLabels));
  }
  return vacancies.length;
}

export async function tailorApplication(userId: string, vacancyId: number): Promise<GeneratedApplication> {
  requireApprovedUser(userId);
  if (usageInLast24Hours(userId, 'application') >= config.userDailyApplicationLimit) {
    throw new Error(`Daily application-generation limit (${config.userDailyApplicationLimit}) reached.`);
  }
  const vacancy = getScoredVacancy(userId, vacancyId);
  if (!vacancy) throw new Error(`Scored vacancy ${vacancyId} was not found for this user.`);
  clearApplicationArtifacts(userId, vacancyId);
  beginApplication(userId, vacancyId);
  try {
    const id = `${userId}-application-${vacancyId}-${vacancy.contentHash.slice(0, 12)}-${Date.now()}`;
    const agent = init(TailorApplication, { id });
    recordUsage(userId, 'application');
    const language = detectCvLanguage(`${vacancy.name}\n${vacancy.description}`);
    const template = getCvTemplate(userId, language);
    if (!template) throw new Error(`${language.toUpperCase()} CV template was not found.`);
    const receipt = await agent.dispatch({
      initialData: { userId, vacancyId },
      message: { kind: 'user', body: 'Prepare the application documents now from the stored canonical CV content.' },
    });
    await agent.read(receipt);
    const application = getApplicationArtifacts(userId, vacancyId);
    if (!application) throw new Error('Application agent did not save the documents.');
    return application;
  } catch (error) {
    clearApplicationArtifacts(userId, vacancyId);
    failApplication(userId, vacancyId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
