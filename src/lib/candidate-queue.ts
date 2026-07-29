import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import {
  candidatesDueForRefresh, candidatesNeedingPrefilter, getCvTemplate, markCandidateClosed, markCandidateFailed, markCandidateNormalized,
  rankedCandidateQueue, saveCandidatePrefilter, upsertVacancy, type Vacancy, type VacancyCandidate, type VacancyInput,
} from './database.ts';
import { prefilterVacancy } from './prefilter.ts';
import { embeddingCosine, semanticEmbedding } from './semantic-embeddings.ts';
import { normalizeHhCandidates } from './hh.ts';
import { normalizeHireHiCandidate, type HireHiListJob } from './hirehi.ts';
import { normalizeAdditionalCandidate } from './additional-sources.ts';
import { trace } from './trace.ts';
import { errorMessage } from './logging.ts';

function candidateVacancy(candidate: VacancyCandidate): Vacancy {
  return {
    id: 0, source: candidate.source, sourceId: candidate.sourceId, applyId: 'aaaaaa',
    name: candidate.title || candidate.searchName, employer: '', area: '', salaryFrom: null, salaryTo: null,
    salaryCurrency: null, salaryGross: null, experience: '', employment: '', schedule: '', workFormat: '',
    // Listing summaries vary wildly by source, so regex/lexical ranking is deliberately title/query based.
    description: candidate.searchName, keySkills: [], url: candidate.url,
    publishedAt: candidate.publishedAt, sourceQuery: candidate.searchName, contentHash: candidate.listingHash, decision: 'new',
  };
}

type QueueProgress = (phase: 'filtering' | 'normalization', current: number, total: number) => void;

async function prefilterCandidates(userIds: string[], progress?: QueueProgress): Promise<{ evaluated: number; queued: number }> {
  const profiles = userIds.map((userId) => {
    const ru = getCvTemplate(userId, 'ru'); const en = getCvTemplate(userId, 'en');
    if (!ru || !en) return null;
    const cvText = `${ru.cvText}\n\n${en.cvText}`;
    return { userId, cvText, cvHash: createHash('sha256').update(cvText).digest('hex') };
  }).filter((profile) => profile !== null);
  if (!profiles.length) return { evaluated: 0, queued: 0 };
  const profileContext = profiles.map(({ userId, cvHash }) => `${userId}:${cvHash}`).sort().join('|');
  const contextHash = createHash('sha256').update(['candidate-prefilter-v4-multiuser', profileContext,
    config.prefilterMinScore, config.semanticPrefilterEnabled, config.semanticEmbeddingModel,
    config.semanticEmbeddingDtype].join(':')).digest('hex');
  const candidates = candidatesNeedingPrefilter(contextHash, config.candidatePrefilterBatchSize);
  const cvVectors = new Map<string, Float32Array>();
  if (config.semanticPrefilterEnabled && candidates.length) {
    for (const profile of profiles) {
      try { cvVectors.set(profile.userId, await semanticEmbedding('cv', profile.cvHash, profile.cvText, profile.userId)); }
      catch (error) { console.warn(`Candidate semantic ranking unavailable for user ${profile.userId}: ${errorMessage(error)}`); }
    }
  }
  let queued = 0;
  progress?.('filtering', 0, candidates.length);
  for (const [index, candidate] of candidates.entries()) {
    const vacancy = candidateVacancy(candidate);
    let vacancyVector: Float32Array | undefined;
    if (cvVectors.size) {
      try {
        const semanticText = `${candidate.title}\n${candidate.title}\n${candidate.searchName}\n${candidate.summary.slice(0, 500)}`;
        vacancyVector = await semanticEmbedding('vacancy', `candidate-v4:${candidate.listingHash}`, semanticText);
      } catch (error) { console.warn(`Candidate embedding failed for ${candidate.source}:${candidate.sourceId}: ${errorMessage(error)}`); }
    }
    const ranked = profiles.map((profile) => {
      const cvVector = cvVectors.get(profile.userId);
      const semanticCosine = cvVector && vacancyVector ? embeddingCosine(cvVector, vacancyVector) : null;
      const lexical = prefilterVacancy(profile.cvText, vacancy, config.prefilterMinScore);
      const result = semanticCosine == null ? lexical
        : prefilterVacancy(profile.cvText, vacancy, config.prefilterMinScore, semanticCosine);
      return { userId: profile.userId, result, semanticCosine };
    }).sort((left, right) => right.result.combinedScore - left.result.combinedScore);
    const best = ranked[0];
    saveCandidatePrefilter(candidate, contextHash, { ...best.result,
      semanticStatus: best.semanticCosine == null ? (config.semanticPrefilterEnabled ? 'unavailable' : 'disabled') : 'ready',
      auditSelected: false });
    if (!best.result.filtered) queued++;
    trace('candidate.prefilter.scored', { source: candidate.source, sourceId: candidate.sourceId,
      title: candidate.title, bestUserId: best.userId, ...best.result });
    progress?.('filtering', index + 1, candidates.length);
  }
  return { evaluated: candidates.length, queued };
}

async function normalizeOne(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  if (candidate.source === 'hirehi') return normalizeHireHiCandidate(candidate.payload as HireHiListJob, candidate.searchName);
  return normalizeAdditionalCandidate(candidate);
}

export interface CandidateQueueResult { evaluated: number; queued: number; selected: number; refreshed: number; normalized: number; failed: number; closed: number; bySource: Record<string, number> }

export async function processCandidateQueue(userIds: string[], progress?: QueueProgress): Promise<CandidateQueueResult> {
  const prefilter = await prefilterCandidates(userIds, progress);
  const refresh = candidatesDueForRefresh(Math.min(config.candidateRefreshBatchSize, config.normalizationBatchSize), config.candidateRefreshDays);
  const selected = [...rankedCandidateQueue(Math.max(0, config.normalizationBatchSize - refresh.length)), ...refresh];
  trace('candidate.queue.ranked', { batchSize: config.normalizationBatchSize,
    selected: selected.map((candidate) => ({ source: candidate.source, sourceId: candidate.sourceId,
      title: candidate.title, score: candidate.combinedScore })) });
  const hh = selected.filter((candidate) => candidate.source === 'hh');
  const hhResults = await normalizeHhCandidates(hh);
  let normalized = 0; let failed = 0; let closed = 0;
  const bySource: Record<string, number> = {};
  progress?.('normalization', 0, selected.length);
  for (const [index, candidate] of selected.entries()) {
    try {
      const result = candidate.source === 'hh' ? hhResults.get(candidate.sourceId) : await normalizeOne(candidate);
      if (result instanceof Error) throw result;
      if (!result) { markCandidateClosed(candidate); closed++; continue; }
      const saved = upsertVacancy(result);
      markCandidateNormalized(candidate, saved.id, Boolean(saved.duplicate));
      if (saved.needsScore) { normalized++; bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1; }
      trace('candidate.normalized', { source: candidate.source, sourceId: candidate.sourceId, saved, vacancy: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:404|410)\b|not found|archived|закрыт|в архиве/i.test(message)) { markCandidateClosed(candidate); closed++; }
      else { failed++; markCandidateFailed(candidate, message); }
      console.error(`Failed to normalize queued candidate ${candidate.source}:${candidate.sourceId}: ${errorMessage(error)}`);
    }
    progress?.('normalization', index + 1, selected.length);
  }
  return { ...prefilter, selected: selected.length, refreshed: refresh.length, normalized, failed, closed, bySource };
}
