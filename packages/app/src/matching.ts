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
  uncalibratedGateWarned = false;
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

let uncalibratedGateWarned = false;
function warnUncalibratedGate(): void {
  if (uncalibratedGateWarned) return;
  uncalibratedGateWarned = true;
  console.error(`PREFILTER_MIN_PROBABILITY=${config.prefilterMinProbability} is set but no calibration is active, `
    + `so admission falls back to PREFILTER_MIN_SCORE=${config.prefilterMinScore} alone. If that floor was lowered `
    + 'because the probability gate was meant to replace it, matching is now far more permissive than intended.');
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

export interface AdmissionInput {
  /** The raw evidence gate's verdict — combined score below PREFILTER_MIN_SCORE. */
  filtered: boolean;
  /** Too old to be worth anyone's time; never admitted and never explored. */
  expired: boolean;
  /** The calibrated gate's verdict, already resolved against an active calibration by the caller. */
  belowProbability: boolean;
  explorationRate: number;
  random?: () => number;
}

/**
 * Whether a match reaches the scoring queue. Either gate can reject it, but a rejection is never final on its
 * own: the exploration dice admit a slice regardless, because a gate that only ever sees what it already admits
 * cannot learn that it is set wrong. Expiry is the one unconditional refusal — no verdict on a filled advert is
 * worth buying.
 */
export function admitEvidence(input: AdmissionInput): boolean {
  if (input.expired) return false;
  if (!input.filtered && !input.belowProbability) return true;
  return (input.random ?? Math.random)() < input.explorationRate;
}

/**
 * One lens's verdict: the stored score orders claimForScoring's spending, so it is the calibrated probability
 * when one is active and the raw combined score otherwise; the raw evidence rides along as the future training
 * row.
 */
export function matchEvidence(lens: UserLens, vacancy: Vacancy, now: Date): MatchEvidence | null {
  const result = prefilterVacancy(
    lens.cvText, vacancy, config.prefilterMinScore, lens.profile, config.prefilterMaxAgeDays,
    roleTokenResolver(),
  );
  const active = calibration;
  const stored = active ? Math.round(100 * calibratedMatchProbability(active, {
    regexScore: result.regexScore, lexicalCosine: result.lexicalCosine,
    titleSimilarity: result.titleSimilarity, skillCoverage: result.skillCoverage,
    source: vacancy.source,
    ageBand: vacancyRecency(vacancy, now.getTime(), config.prefilterMaxAgeDays).band,
  })) : Math.max(0, Math.round(result.combinedScore));
  const evidence: MatchEvidence = { score: stored, regexScore: result.regexScore,
    lexicalCosine: result.lexicalCosine, titleSimilarity: result.titleSimilarity,
    skillCoverage: result.skillCoverage };
  // The calibrated gate only means anything while a calibration is active; without one `stored` is the raw
  // combined score, which is not a probability and must not be compared against one. A deployment that made the
  // probability its main gate has usually lowered PREFILTER_MIN_SCORE to match, so losing the calibration means
  // falling back to a floor that was never meant to hold the line on its own. Say so, once, loudly.
  if (config.prefilterMinProbability > 0 && active == null) warnUncalibratedGate();
  const belowProbability = active != null && config.prefilterMinProbability > 0
    && stored < config.prefilterMinProbability;
  return admitEvidence({ filtered: result.filtered, expired: result.expired, belowProbability,
    explorationRate: config.prefilterExplorationRate }) ? evidence : null;
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
      regexScore: evidence.regexScore, lexicalCosine: evidence.lexicalCosine,
      titleSimilarity: evidence.titleSimilarity, skillCoverage: evidence.skillCoverage });
  }
  return candidates.length ? createMatches(candidates, now) : 0;
}
