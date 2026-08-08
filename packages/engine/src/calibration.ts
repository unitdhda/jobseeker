/**
 * Calibrated admission/ordering probability for the lexical prefilter.
 *
 * The prefilter's combined score orders LLM spending, but measured against the LLM's own judgements it is a weak
 * and non-monotonic predictor. These coefficients come from a logistic regression fitted offline on scored
 * matches (scripts/fit-prefilter-calibration.ts); the serving side is one dot product, so the model lives in
 * configuration and a bad fit rolls back by unsetting it.
 *
 * Feature scaling is part of the contract and must match the fit script byte for byte:
 *   regexScore   -> regexScore / 100, clamped to [0, 1]; its square is a separate coefficient
 *   lexicalCosine -> lexicalCosine * 3, clamped to [0, 1] (cosines land in ~[0, 0.33]); square likewise
 *   titleSimilarity, skillCoverage -> already 0..1, clamped and used as they are
 *   source, ageBand -> per-key intercepts; an unknown key contributes 0, making it the reference class.
 *
 * Version 2 added titleSimilarity and skillCoverage: `regexScore` folds those two together, and a fit cannot
 * separate signals it never sees. A version 1 document stays valid and carries no coefficient for them, which
 * contributes nothing — so an old accepted calibration keeps serving unchanged until a refit replaces it.
 *
 * Version 3 added `judges` and `users`, which are **fitted but never served**. Neither is knowable when a match
 * is scored — the judge has not run yet, and the user is constant across everything in their own queue — so
 * neither can change the ordering the prefilter exists to produce. They are nuisance parameters: they exist so
 * that a strict judge or a demanding user is charged to their own intercept instead of contaminating the
 * evidence coefficients. Production had at least four scoring routes live in one week with the positive rate
 * swinging between 22% and 60%, which is exactly the contamination this absorbs. They are written into the
 * document for the audit trail; `calibratedMatchProbability` ignores them, and the types keep them off the
 * serving path.
 */
import * as v from 'valibot';
import type { RecencyBand } from './prefilter.ts';

const coefficient = v.pipe(v.number(), v.finite());

export const calibrationVersion = 3;

export const prefilterCalibrationSchema = v.strictObject({
  version: v.union([v.literal(1), v.literal(2), v.literal(3)]),
  bias: coefficient,
  regexScore: coefficient,
  regexScoreSquared: v.optional(coefficient, 0),
  lexicalCosine: coefficient,
  lexicalCosineSquared: v.optional(coefficient, 0),
  /** Absent from a version 1 document, where the signal was folded into regexScore. */
  titleSimilarity: v.optional(coefficient, 0),
  skillCoverage: v.optional(coefficient, 0),
  /** Signed, unlike the rest: the advert may ask above or below the CV's grade, and those are not the same. */
  seniorityGap: v.optional(coefficient, 0),
  sources: v.record(v.string(), coefficient),
  ageBands: v.record(v.string(), coefficient),
  /** Fitting-only intercepts, absent before version 3. Recorded for audit; never read when serving. */
  judges: v.optional(v.record(v.string(), coefficient), {}),
  users: v.optional(v.record(v.string(), coefficient), {}),
});

export type PrefilterCalibration = v.InferOutput<typeof prefilterCalibrationSchema>;

export function parsePrefilterCalibration(json: string): PrefilterCalibration {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Prefilter calibration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = v.safeParse(prefilterCalibrationSchema, value);
  if (!parsed.success) {
    throw new Error(`Prefilter calibration is invalid: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.output;
}

export interface CalibrationFeatures {
  regexScore: number;
  lexicalCosine: number;
  /** Both 0..1. Rows predating the columns pass 0, which contributes nothing. */
  titleSimilarity?: number;
  skillCoverage?: number;
  /** -1..1, or null/undefined when neither title named a grade. Absent contributes nothing, like the rest. */
  seniorityGap?: number | null;
  source: string;
  ageBand: RecencyBand;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clampSigned = (value: number | null | undefined): number =>
  (value == null ? 0 : Math.max(-1, Math.min(1, value)));

/** P(the LLM would judge this match worth delivering), in [0, 1]. */
export function calibratedMatchProbability(calibration: PrefilterCalibration,
  features: CalibrationFeatures): number {
  return sigmoid(logit(calibration, features));
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

function logit(calibration: PrefilterCalibration, features: CalibrationFeatures): number {
  const regex01 = clamp01(features.regexScore / 100);
  const cosine01 = clamp01(features.lexicalCosine * 3);
  return calibration.bias
    + calibration.regexScore * regex01 + calibration.regexScoreSquared * regex01 * regex01
    + calibration.lexicalCosine * cosine01 + calibration.lexicalCosineSquared * cosine01 * cosine01
    + calibration.titleSimilarity * clamp01(features.titleSimilarity ?? 0)
    + calibration.skillCoverage * clamp01(features.skillCoverage ?? 0)
    + calibration.seniorityGap * clampSigned(features.seniorityGap)
    + (calibration.sources[features.source] ?? 0)
    + (calibration.ageBands[features.ageBand] ?? 0);
}

/** A labelled example: the evidence recorded at match time plus the LLM's later verdict. */
export interface CalibrationExample extends CalibrationFeatures { label: boolean }

/**
 * What a fit consumes. The extra fields exist only here, never in `CalibrationFeatures`, because they cannot be
 * known or used at serving time — see the note on version 3 above.
 */
export interface TrainingExample extends CalibrationExample {
  /** When the verdict landed, in epoch milliseconds. The holdout is the newest tail of these. */
  scoredAt: number;
  /** The model that produced the verdict, if it was recorded. */
  judge?: string;
  /** Whose verdict it is. */
  user?: string;
}

export interface CalibrationEvaluation {
  auc: number;
  /** Precision in the best-ranked fifth — the fraction of top-of-queue claims the LLM would endorse. */
  precisionAtTop20: number;
}

export interface CalibrationFit {
  /** Fitted on every example. This is the document that ships. */
  calibration: PrefilterCalibration;
  /**
   * The training-only model measured on the held-out tail. It is not literally the document above — what is
   * being validated is the fitting procedure, on rows it could not have seen, which is the only question a
   * daily refit can honestly ask.
   */
  candidate: CalibrationEvaluation;
  /** Indices into the caller's array, newest tail, so an incumbent can be judged on identical rows. */
  holdoutIndices: readonly number[];
  /** The training-only model's serving score per holdout row, in `holdoutIndices` order. */
  holdoutScores: readonly number[];
  examples: number;
  positives: number;
  /** False when the holdout is too small or single-class for any comparison to mean anything. */
  judgeable: boolean;
}

function evaluateOrdering(scored: { score: number; label: boolean }[]): CalibrationEvaluation {
  // Mann-Whitney AUC via average ranks: identical to counting every positive/negative pair with ties at half,
  // but O(n log n) instead of O(positives × negatives), so a full-size labelled corpus evaluates in milliseconds.
  const positives = scored.reduce((count, entry) => count + (entry.label ? 1 : 0), 0);
  const negatives = scored.length - positives;
  const ascending = [...scored].sort((left, right) => left.score - right.score);
  let positiveRankSum = 0;
  for (let start = 0; start < ascending.length;) {
    let end = start;
    while (end + 1 < ascending.length && ascending[end + 1]!.score === ascending[start]!.score) end++;
    const averageRank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index++) if (ascending[index]!.label) positiveRankSum += averageRank;
    start = end + 1;
  }
  const auc = positives && negatives
    ? (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives) : Number.NaN;
  const k = Math.max(1, Math.round(scored.length / 5));
  const top = [...scored].sort((left, right) => right.score - left.score).slice(0, k);
  return { auc, precisionAtTop20: top.filter((entry) => entry.label).length / k };
}

/** How an existing coefficient set orders a labelled sample — the bar a refit has to clear. */
export function evaluateCalibration(calibration: PrefilterCalibration,
  examples: readonly CalibrationExample[]): CalibrationEvaluation {
  return evaluateOrdering(examples.map((example) => ({
    score: calibratedMatchProbability(calibration, example), label: example.label })));
}

/** The bootstrap bar when no calibration is active yet: the ordering of the scores already stored. */
export function evaluateScores(scores: readonly number[],
  examples: readonly CalibrationExample[]): CalibrationEvaluation {
  return evaluateOrdering(examples.map((example, index) => ({
    score: scores[index] ?? 0, label: example.label })));
}

const recencyBandNames = ['week', 'fortnight', 'month', 'stale'] as const; // 'today' is the reference class.
const minimumSourceExamples = 30;

/** The dummy-coded columns a fit uses beyond the evidence: served (sources) and fitting-only (judges, users). */
interface DummyColumns { sources: readonly string[]; judges: readonly string[]; users: readonly string[] }

function featureVector(example: TrainingExample, columns: DummyColumns): number[] {
  const regex01 = clamp01(example.regexScore / 100);
  const cosine01 = clamp01(example.lexicalCosine * 3);
  return [1, regex01, regex01 * regex01, cosine01, cosine01 * cosine01,
    clamp01(example.titleSimilarity ?? 0), clamp01(example.skillCoverage ?? 0),
    clampSigned(example.seniorityGap),
    ...columns.sources.map((source) => (source === example.source ? 1 : 0)),
    ...recencyBandNames.map((band) => (band === example.ageBand ? 1 : 0)),
    ...columns.judges.map((judge) => (judge === example.judge ? 1 : 0)),
    ...columns.users.map((user) => (user === example.user ? 1 : 0))];
}

// The fitter shares its process with the Telegram receiver and the health endpoints, so a long descent must not
// hold the event loop; it hands control back whenever it has computed for about this long.
const descentYieldBudgetMs = 8;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Bias, the four evidence terms, the two split signals, and the signed seniority gap. */
const denseFeatureCount = 8;

async function descend(examples: readonly TrainingExample[],
  columns: DummyColumns): Promise<number[]> {
  const width = denseFeatureCount + columns.sources.length + recencyBandNames.length
    + columns.judges.length + columns.users.length;
  const weights = new Array<number>(width).fill(0);
  const learningRate = 0.5; const l2 = 1e-3; const iterations = 4000;
  const vectors = examples.map((example) => featureVector(example, columns));
  let lastYield = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = new Array<number>(width).fill(0);
    for (const [row, vector] of vectors.entries()) {
      const error = sigmoid(vector.reduce((sum, value, index) => sum + value * weights[index]!, 0))
        - (examples[row]!.label ? 1 : 0);
      for (let index = 0; index < width; index++) gradient[index]! += error * vector[index]!;
    }
    for (let index = 0; index < width; index++) {
      weights[index]! -= learningRate * (gradient[index]! / examples.length + (index === 0 ? 0 : l2 * weights[index]!));
    }
    if (performance.now() - lastYield >= descentYieldBudgetMs) {
      await yieldToEventLoop();
      lastYield = performance.now();
    }
  }
  return weights;
}

function toCalibration(weights: readonly number[], columns: DummyColumns): PrefilterCalibration {
  const round = (value: number): number => Number(value.toFixed(4));
  const bandsAt = denseFeatureCount + columns.sources.length;
  const judgesAt = bandsAt + recencyBandNames.length;
  const usersAt = judgesAt + columns.judges.length;
  return { version: calibrationVersion, bias: round(weights[0]!), regexScore: round(weights[1]!),
    regexScoreSquared: round(weights[2]!), lexicalCosine: round(weights[3]!),
    lexicalCosineSquared: round(weights[4]!),
    titleSimilarity: round(weights[5]!), skillCoverage: round(weights[6]!),
    seniorityGap: round(weights[7]!),
    sources: Object.fromEntries(columns.sources.map((source, index) =>
      [source, round(weights[denseFeatureCount + index]!)])),
    ageBands: Object.fromEntries(recencyBandNames.map((band, index) =>
      [band, round(weights[bandsAt + index]!)])),
    judges: Object.fromEntries(columns.judges.map((judge, index) => [judge, round(weights[judgesAt + index]!)])),
    users: Object.fromEntries(columns.users.map((user, index) => [user, round(weights[usersAt + index]!)])) };
}

/** A class earns an intercept only where the sample supports one — decided from the rows being fitted. */
function eligible(examples: readonly TrainingExample[],
  key: (example: TrainingExample) => string | undefined): string[] {
  const counts = new Map<string, number>();
  for (const example of examples) {
    const value = key(example);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= minimumSourceExamples)
    .map(([value]) => value).sort();
}

function dummyColumns(examples: readonly TrainingExample[]): DummyColumns {
  return {
    sources: eligible(examples, (example) => example.source),
    judges: eligible(examples, (example) => example.judge),
    users: eligible(examples, (example) => example.user),
  };
}

/** The tail must be big enough, and mixed enough, for a comparison on it to carry any information. */
const minimumHoldoutRows = 50;
const minimumHoldoutPerClass = 5;

/**
 * Fits a fresh calibration by full-batch logistic regression and validates it on the newest rows only.
 *
 * The split is by time, not at random. Random k-fold puts rows from the same hours on both sides of the split,
 * which flatters a model that will only ever be asked about the future: measured that way the live calibration
 * looked like a clear win over the raw score (0.715 vs 0.642), while on the rows that arrived after it was
 * fitted the two were indistinguishable (0.909 vs 0.913). A time split asks the question deployment asks.
 *
 * The shipped document is fitted on everything, including the holdout — what the metrics validate is the
 * procedure, not that exact object. Column eligibility inside the validated model is decided from training rows
 * alone, so no column is chosen with the holdout's help. Deterministic for a given input; asynchronous only to
 * keep the event loop responsive while fitting.
 */
export async function fitPrefilterCalibration(examples: readonly TrainingExample[],
  options: { holdoutShare?: number } = {}): Promise<CalibrationFit> {
  const share = Math.max(0.1, Math.min(0.5, options.holdoutShare ?? 0.25));
  const order = examples.map((_, index) => index)
    .sort((left, right) => examples[left]!.scoredAt - examples[right]!.scoredAt || left - right);
  const split = Math.floor(order.length * (1 - share));
  const trainingIndices = order.slice(0, split);
  const holdoutIndices = order.slice(split);
  const holdout = holdoutIndices.map((index) => examples[index]!);
  const positivesInHoldout = holdout.filter((example) => example.label).length;
  const judgeable = trainingIndices.length > 0 && holdout.length >= minimumHoldoutRows
    && positivesInHoldout >= minimumHoldoutPerClass
    && holdout.length - positivesInHoldout >= minimumHoldoutPerClass;

  let holdoutScores: number[] = [];
  let candidate: CalibrationEvaluation = { auc: Number.NaN, precisionAtTop20: Number.NaN };
  if (judgeable) {
    const training = trainingIndices.map((index) => examples[index]!);
    const columns = dummyColumns(training);
    const validated = toCalibration(await descend(training, columns), columns);
    // Scored through the serving path, so the judge and user intercepts contribute nothing here either.
    holdoutScores = holdout.map((example) => calibratedMatchProbability(validated, example));
    candidate = evaluateOrdering(holdout.map((example, index) => ({
      score: holdoutScores[index]!, label: example.label })));
  }

  const columns = dummyColumns(examples);
  return {
    calibration: toCalibration(await descend(examples, columns), columns),
    candidate,
    holdoutIndices,
    holdoutScores,
    examples: examples.length,
    positives: examples.filter((example) => example.label).length,
    judgeable,
  };
}

export interface HoldoutComparison {
  accepted: boolean;
  candidate: CalibrationEvaluation;
  incumbent: CalibrationEvaluation;
  /** Candidate minus incumbent AUC on the holdout, and the low end of its paired bootstrap interval. */
  deltaAuc: number;
  deltaAucLower: number;
  holdoutExamples: number;
  reason: string;
}

/**
 * Decides whether a candidate ordering may replace the incumbent, on rows both are scored against.
 *
 * The comparison is paired and bootstrapped because the naive test it replaces — "accept if AUC is no more than
 * 0.01 worse" — is finer than its own measurement error: an AUC over a few hundred rows moves by ±0.02–0.03
 * between samples, so that rule cannot distinguish a real regression from resampling noise. Resampling the same
 * rows for both models cancels the luck of the draw, leaving the difference itself, and a candidate is adopted
 * only when the low end of that difference's interval is still no worse than the tolerance.
 */
export function compareOnHoldout(candidateScores: readonly number[], incumbentScores: readonly number[],
  labels: readonly boolean[],
  options: { tolerance?: number; samples?: number; confidence?: number } = {}): HoldoutComparison {
  const tolerance = options.tolerance ?? 0.01;
  const samples = options.samples ?? 500;
  const confidence = options.confidence ?? 0.95;
  const candidate = evaluateOrdering(candidateScores.map((score, index) => ({ score, label: labels[index]! })));
  const incumbent = evaluateOrdering(incumbentScores.map((score, index) => ({ score, label: labels[index]! })));
  const base = {
    candidate, incumbent, holdoutExamples: labels.length,
    deltaAuc: candidate.auc - incumbent.auc, deltaAucLower: Number.NaN,
  };
  if (!Number.isFinite(candidate.auc) || !Number.isFinite(incumbent.auc)) {
    return { ...base, accepted: false, reason: 'the holdout is single-class, so neither ordering can be scored' };
  }
  let seed = 20_260_808;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const deltas: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const picks = Array.from({ length: labels.length }, () => Math.floor(random() * labels.length));
    const drawn = picks.map((index) => ({ label: labels[index]!, index }));
    const resampledCandidate = evaluateOrdering(drawn.map((row) => ({
      score: candidateScores[row.index]!, label: row.label })));
    const resampledIncumbent = evaluateOrdering(drawn.map((row) => ({
      score: incumbentScores[row.index]!, label: row.label })));
    // A resample that lands single-class says nothing about the difference; skip it rather than score it 0.
    if (Number.isFinite(resampledCandidate.auc) && Number.isFinite(resampledIncumbent.auc)) {
      deltas.push(resampledCandidate.auc - resampledIncumbent.auc);
    }
  }
  if (!deltas.length) {
    return { ...base, accepted: false, reason: 'every bootstrap resample landed single-class' };
  }
  deltas.sort((left, right) => left - right);
  const lower = deltas[Math.min(deltas.length - 1, Math.floor((1 - confidence) * deltas.length))]!;
  const accepted = lower >= -tolerance;
  return { ...base, deltaAucLower: lower, accepted,
    reason: accepted
      ? `candidate is no worse: AUC delta ${base.deltaAuc.toFixed(3)}, ${(100 * confidence).toFixed(0)}% lower bound ${lower.toFixed(3)} >= -${tolerance}`
      : `candidate may be worse: AUC delta ${base.deltaAuc.toFixed(3)}, ${(100 * confidence).toFixed(0)}% lower bound ${lower.toFixed(3)} < -${tolerance}` };
}
