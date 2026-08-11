/** Per-user lexical candidate gate and semantic-prescore queue ordering. */
import { config } from './config.ts';
import {
  combinedEvidenceScore, parseStoredCareerProfile, prefilterVacancy, vacancyRecency, careerProfilePlatformId,
  type CareerProfile, type MatchEvidence, type StoredCareerProfile,
} from '@jobseeker/engine';
import {
  claimMatches, createMatches, getCvSource, getSearchProfile, pendingMatchesForScoring, vacanciesForBackfill,
  type PendingMatch, type Vacancy,
} from './postgres.ts';
import { roleTokenResolver } from './role-equivalence.ts';
import { idfLookups } from './idf.ts';

export interface UserLens { userId: string; cvText: string; profile: CareerProfile }

/** A user who can judge a vacancy: a CV and a career profile current for it. */
export async function userLens(userId: string): Promise<UserLens | null> {
  const cv = await getCvSource(userId);
  if (!cv) return null;
  const profile = parseStoredCareerProfile(
    await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256);
  return profile ? { userId, cvText: cv.cvText, profile } : null;
}

/** Free deterministic evidence only bounds mini-model traffic; it is not a learned model. */
export function matchEvidence(lens: UserLens, vacancy: Vacancy, now: Date): MatchEvidence | null {
  const result = prefilterVacancy(
    lens.cvText, vacancy, config.prefilterMinScore, lens.profile, config.prefilterMaxAgeDays,
    roleTokenResolver(), idfLookups(),
  );
  if (result.filtered || result.expired) return null;
  return {
    score: Math.max(0, Math.round(result.combinedScore)), regexScore: result.regexScore,
    lexicalCosine: result.lexicalCosine, titleSimilarity: result.titleSimilarity,
    skillCoverage: result.skillCoverage, seniorityGap: result.seniorityGap,
    specificity: result.specificity, lexicalCosineIdf: result.lexicalCosineIdf,
  };
}

/** Semantic score owns ordering while configured; raw evidence is the environment-only fallback. */
export function matchOrderingScore(candidate: PendingMatch, now: Date): number {
  if (config.prescoringModel && candidate.prescoreScore != null) return candidate.prescoreScore;
  const recency = vacancyRecency({ publishedAt: candidate.publishedAt }, now.getTime(), config.prefilterMaxAgeDays);
  return combinedEvidenceScore(candidate.regexScore ?? 0, candidate.lexicalCosine ?? 0, recency.weight);
}

export const claimCandidateCap = 5_000;
let rankingCapWarned = false;

/** The semantic gate's production decision; exploration is frozen when its score lands. */
export function admitPrescore(score: number | null | undefined, exploration: boolean | undefined,
  minimum = config.prescoreMinScore): boolean {
  return score != null && (score >= minimum || exploration === true);
}

/** Ranks everything this user has waiting and takes the best `limit`, best first. */
export async function claimForScoring(userId: string, limit: number, now = new Date()): Promise<number[]> {
  if (limit <= 0) return [];
  const waiting = await pendingMatchesForScoring(userId, claimCandidateCap, config.prescoringModel,
    config.prescorePromptVersion, config.prescoreMinScore);
  const candidates = config.prescoringModel
    ? waiting.filter((candidate) => admitPrescore(candidate.prescoreScore, candidate.prescoreExploration))
    : waiting;
  if (waiting.length >= claimCandidateCap && !rankingCapWarned) {
    rankingCapWarned = true;
    console.error(`A user has at least ${claimCandidateCap} matches waiting, which is the ranking cap: their `
      + 'queue is being ordered on a truncated view and its tail is unreachable.');
  }
  const ranked = candidates.map((candidate) => ({ candidate, score: matchOrderingScore(candidate, now) }))
    .sort((left, right) => right.score - left.score
      || Date.parse(right.candidate.matchedAt) - Date.parse(left.candidate.matchedAt)
      || left.candidate.vacancyId - right.candidate.vacancyId)
    .slice(0, limit);
  const claimed = new Set(await claimMatches(userId, ranked.map((entry) => entry.candidate.vacancyId)));
  return ranked.map((entry) => entry.candidate.vacancyId).filter((vacancyId) => claimed.has(vacancyId));
}

const backfillScanLimit = 3_000;

/** Matches a fresh CV/profile against recent normalized stock once. */
export async function backfillUserMatches(userId: string, now = new Date()): Promise<number> {
  const lens = await userLens(userId);
  if (!lens) return 0;
  const since = new Date(now.getTime() - config.prefilterMaxAgeDays * 86_400_000).toISOString();
  const vacancies = await vacanciesForBackfill(userId, since, backfillScanLimit);
  const candidates = [];
  for (const vacancy of vacancies) {
    const evidence = matchEvidence(lens, vacancy, now);
    if (evidence) candidates.push({ userId, vacancyId: vacancy.id, lexicalScore: evidence.score,
      regexScore: evidence.regexScore, lexicalCosine: evidence.lexicalCosine,
      titleSimilarity: evidence.titleSimilarity, skillCoverage: evidence.skillCoverage,
      seniorityGap: evidence.seniorityGap, specificity: evidence.specificity,
      lexicalCosineIdf: evidence.lexicalCosineIdf });
  }
  return candidates.length ? createMatches(candidates, now) : 0;
}
