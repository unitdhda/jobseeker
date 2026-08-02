import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import {
  candidatesDueForRefresh, candidatesNeedingPrefilter, getCvSource, getSearchProfile, markCandidateClosed, markCandidateFailed,
  markCandidateNormalized, rankedCandidateQueueForUsers, saveCandidatePrefilter, upsertVacancy,
  type Vacancy, type VacancyCandidate, type VacancyInput,
} from './database.ts';
import { prefilterVacancy } from './prefilter.ts';
import { normalizePlatformCandidates } from '../platforms/registry.ts';
import { trace } from './trace.ts';
import { errorMessage } from './logging.ts';
import { careerProfilePlatformId, parseStoredCareerProfile, type StoredCareerProfile } from './career-profile.ts';

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
  const profiles = (await Promise.all(userIds.map(async (userId) => {
    const cv = await getCvSource(userId);
    if (!cv) return null;
    const careerProfile = parseStoredCareerProfile(
      await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256,
    );
    if (!careerProfile) return null;
    const profileHash = createHash('sha256').update(JSON.stringify(careerProfile)).digest('hex');
    const contextHash = createHash('sha256').update(['candidate-prefilter-v6-lexical-per-user', cv.cvSha256, profileHash,
      config.prefilterMinScore].join(':')).digest('hex');
    const candidates = await candidatesNeedingPrefilter(userId, contextHash, config.candidatePrefilterBatchSize);
    return { userId, cvText: cv.cvText, cvHash: cv.cvSha256, careerProfile, contextHash, candidates };
  }))).filter((profile) => profile !== null);
  const total = profiles.reduce((sum, profile) => sum + profile.candidates.length, 0);
  if (!total) return { evaluated: 0, queued: 0 };
  let completed = 0; let queued = 0;
  progress?.('filtering', 0, total);
  for (const profile of profiles) {
    for (const candidate of profile.candidates) {
      const vacancy = candidateVacancy(candidate);
      const result = prefilterVacancy(profile.cvText, vacancy, config.prefilterMinScore, profile.careerProfile);
      await saveCandidatePrefilter(profile.userId, candidate, profile.contextHash, { ...result, auditSelected: false });
      if (!result.filtered) queued++;
      trace('candidate.prefilter.scored', { userId: profile.userId, source: candidate.source,
        sourceId: candidate.sourceId, title: candidate.title, ...result });
      progress?.('filtering', ++completed, total);
    }
  }
  return { evaluated: total, queued };
}

export interface CandidateQueueResult { evaluated: number; queued: number; selected: number; refreshed: number; normalized: number; failed: number; closed: number; bySource: Record<string, number> }

export async function processCandidateQueue(userIds: string[], progress?: QueueProgress): Promise<CandidateQueueResult> {
  const prefilter = await prefilterCandidates(userIds, progress);
  const capacity = config.normalizationBatchSizePerUser * userIds.length;
  const ranked = await rankedCandidateQueueForUsers(userIds, config.normalizationBatchSizePerUser);
  const refresh = await candidatesDueForRefresh(
    Math.min(config.candidateRefreshBatchSize, Math.max(0, capacity - ranked.length)), config.candidateRefreshDays);
  const selected = [...ranked, ...refresh];
  trace('candidate.queue.ranked', { perUserBatchSize: config.normalizationBatchSizePerUser, capacity,
    selected: selected.map((candidate) => ({ source: candidate.source, sourceId: candidate.sourceId,
      title: candidate.title, score: candidate.combinedScore })) });
  const normalizationResults = new Map<string, VacancyInput | null | Error>();
  for (const source of new Set(selected.map((candidate) => candidate.source))) {
    const candidates = selected.filter((candidate) => candidate.source === source);
    const results = await normalizePlatformCandidates(source,candidates);
    for (const [sourceId,result] of results) normalizationResults.set(`${source}:${sourceId}`,result);
  }
  let normalized = 0; let failed = 0; let closed = 0;
  const bySource: Record<string, number> = {};
  progress?.('normalization', 0, selected.length);
  for (const [index, candidate] of selected.entries()) {
    try {
      const result = normalizationResults.get(`${candidate.source}:${candidate.sourceId}`);
      if (result instanceof Error) throw result;
      if (!result) { await markCandidateClosed(candidate); closed++; continue; }
      const saved = await upsertVacancy(result);
      await markCandidateNormalized(candidate, saved.id, Boolean(saved.duplicate));
      if (saved.needsScore) { normalized++; bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1; }
      trace('candidate.normalized', { source: candidate.source, sourceId: candidate.sourceId, saved, vacancy: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:404|410)\b|not found|archived|закрыт|в архиве/i.test(message)) { await markCandidateClosed(candidate); closed++; }
      else { failed++; await markCandidateFailed(candidate, message); }
      console.error(`Failed to normalize queued candidate ${candidate.source}:${candidate.sourceId}: ${errorMessage(error)}`);
    }
    progress?.('normalization', index + 1, selected.length);
  }
  return { ...prefilter, selected: selected.length, refreshed: refresh.length, normalized, failed, closed, bySource };
}
