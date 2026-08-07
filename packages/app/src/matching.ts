/**
 * The per-user matching lens shared by the engine loop (match-on-ingest) and the profile workflow (backfill):
 * prefilter evidence, the calibrated ordering score, and the exploration dice live here so both paths judge a
 * vacancy identically. Also owns the active-calibration state — the newest accepted `calibrations` row outranks
 * the env bootstrap, in whichever process asks.
 */
import { config } from './config.ts';
import {
  calibratedMatchProbability, parsePrefilterCalibration, parseStoredCareerProfile, prefilterVacancy,
  vacancyRecency, careerProfilePlatformId,
  type CareerProfile, type MatchEvidence, type PrefilterCalibration, type StoredCareerProfile,
} from '@jobseeker/engine';
import {
  activeStoredCalibration, createMatches, getCvSource, getSearchProfile, vacanciesForBackfill, type Vacancy,
} from './postgres.ts';
import { roleTokenResolver } from './role-equivalence.ts';
import { errorMessage } from './observability.ts';

// Parsed once at composition: a malformed calibration fails the process at startup, never one match at a time.
const bootstrapCalibration = config.prefilterCalibrationJson
  ? parsePrefilterCalibration(config.prefilterCalibrationJson) : null;
let calibration: PrefilterCalibration | null = bootstrapCalibration;
let calibrationFittedAt: string | null = null;

export function activeCalibration(): PrefilterCalibration | null { return calibration; }
export function activeCalibrationFittedAt(): string | null { return calibrationFittedAt; }
export function setActiveCalibration(next: PrefilterCalibration, fittedAt: string): void {
  calibration = next;
  calibrationFittedAt = fittedAt;
}

/** A previously accepted refit outranks the env bootstrap; an invalid stored row keeps the bootstrap, loudly. */
export async function loadActiveCalibration(): Promise<void> {
  const stored = await activeStoredCalibration();
  if (!stored) return;
  try {
    setActiveCalibration(parsePrefilterCalibration(JSON.stringify(stored.coefficients)), stored.createdAt);
  } catch (error) {
    console.error(`Stored calibration ${stored.id} is invalid, staying on the bootstrap: ${errorMessage(error)}`);
  }
}

export interface UserLens { userId: string; cvText: string; profile: CareerProfile }

/** A user who can judge a vacancy: a CV and a career profile current for it. Others return null and wait. */
export async function userLens(userId: string): Promise<UserLens | null> {
  const cv = await getCvSource(userId);
  if (!cv) return null;
  const profile = parseStoredCareerProfile(
    await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256);
  return profile ? { userId, cvText: cv.cvText, profile } : null;
}

/**
 * One lens's verdict: the stored score orders claimForScoring's spending, so it is the calibrated probability
 * when one is active and the raw combined score otherwise; the raw evidence rides along as the future training
 * row. An expired advert is never admitted. Below the evidence floor, the exploration rate admits a random
 * slice anyway — those LLM scores are the only labels the calibration ever gets from beyond the gate.
 */
export function matchEvidence(lens: UserLens, vacancy: Vacancy, now: Date): MatchEvidence | null {
  const result = prefilterVacancy(
    lens.cvText, vacancy, config.prefilterMinScore, lens.profile, config.prefilterMaxAgeDays,
    roleTokenResolver(),
  );
  const active = calibration;
  const stored = active ? Math.round(100 * calibratedMatchProbability(active, {
    regexScore: result.regexScore, lexicalCosine: result.lexicalCosine, source: vacancy.source,
    ageBand: vacancyRecency(vacancy, now.getTime(), config.prefilterMaxAgeDays).band,
  })) : Math.max(0, Math.round(result.combinedScore));
  const evidence: MatchEvidence = { score: stored, regexScore: result.regexScore,
    lexicalCosine: result.lexicalCosine };
  if (!result.filtered) return evidence;
  if (result.expired) return null;
  return Math.random() < config.prefilterExplorationRate ? evidence : null;
}

const backfillScanLimit = 3_000;

/**
 * Match-on-ingest only judges vacancies normalized after a user existed, so a fresh CV or profile starts against
 * an empty queue while thousands of live vacancies sit in the store. This runs the new lens over the recent
 * normalized stock once; `createMatches` is insert-or-ignore, so reruns and races with the loop are harmless.
 */
export async function backfillUserMatches(userId: string, now = new Date()): Promise<number> {
  await loadActiveCalibration().catch(() => undefined);
  const lens = await userLens(userId);
  if (!lens) return 0;
  const since = new Date(now.getTime() - config.prefilterMaxAgeDays * 86_400_000).toISOString();
  const vacancies = await vacanciesForBackfill(userId, since, backfillScanLimit);
  const candidates = [];
  for (const vacancy of vacancies) {
    const evidence = matchEvidence(lens, vacancy, now);
    if (evidence) candidates.push({ userId, vacancyId: vacancy.id, lexicalScore: evidence.score,
      regexScore: evidence.regexScore, lexicalCosine: evidence.lexicalCosine });
  }
  return candidates.length ? createMatches(candidates, now) : 0;
}
