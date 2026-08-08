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
 *   source, ageBand -> per-key intercepts; an unknown key contributes 0, making it the reference class.
 */
import * as v from 'valibot';
import type { RecencyBand } from './prefilter.ts';

const coefficient = v.pipe(v.number(), v.finite());

export const prefilterCalibrationSchema = v.strictObject({
  version: v.literal(1),
  bias: coefficient,
  regexScore: coefficient,
  regexScoreSquared: v.optional(coefficient, 0),
  lexicalCosine: coefficient,
  lexicalCosineSquared: v.optional(coefficient, 0),
  sources: v.record(v.string(), coefficient),
  ageBands: v.record(v.string(), coefficient),
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
  source: string;
  ageBand: RecencyBand;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

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
    + (calibration.sources[features.source] ?? 0)
    + (calibration.ageBands[features.ageBand] ?? 0);
}

/** A labelled example: the evidence recorded at match time plus the LLM's later verdict. */
export interface CalibrationExample extends CalibrationFeatures { label: boolean }

export interface CalibrationEvaluation {
  auc: number;
  /** Precision in the best-ranked fifth — the fraction of top-of-queue claims the LLM would endorse. */
  precisionAtTop20: number;
}

export interface CalibrationFit {
  calibration: PrefilterCalibration;
  /** Pooled out-of-fold metrics: every example judged by a model that never trained on it. */
  candidate: CalibrationEvaluation;
  examples: number;
  positives: number;
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

function featureVector(example: CalibrationFeatures, sources: readonly string[]): number[] {
  const regex01 = clamp01(example.regexScore / 100);
  const cosine01 = clamp01(example.lexicalCosine * 3);
  return [1, regex01, regex01 * regex01, cosine01, cosine01 * cosine01,
    ...sources.map((source) => (source === example.source ? 1 : 0)),
    ...recencyBandNames.map((band) => (band === example.ageBand ? 1 : 0))];
}

// The fitter shares its process with the Telegram receiver and the health endpoints, so a long descent must not
// hold the event loop; it hands control back whenever it has computed for about this long.
const descentYieldBudgetMs = 8;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function descend(examples: readonly CalibrationExample[],
  sources: readonly string[]): Promise<number[]> {
  const width = 5 + sources.length + recencyBandNames.length;
  const weights = new Array<number>(width).fill(0);
  const learningRate = 0.5; const l2 = 1e-3; const iterations = 4000;
  const vectors = examples.map((example) => featureVector(example, sources));
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

function toCalibration(weights: readonly number[], sources: readonly string[]): PrefilterCalibration {
  const round = (value: number): number => Number(value.toFixed(4));
  return { version: 1, bias: round(weights[0]!), regexScore: round(weights[1]!),
    regexScoreSquared: round(weights[2]!), lexicalCosine: round(weights[3]!),
    lexicalCosineSquared: round(weights[4]!),
    sources: Object.fromEntries(sources.map((source, index) => [source, round(weights[5 + index]!)])),
    ageBands: Object.fromEntries(recencyBandNames.map((band, index) =>
      [band, round(weights[5 + sources.length + index]!)])) };
}

/** Sources earn an intercept only where the sample supports one — decided from the rows being fitted. */
function eligibleSources(examples: readonly CalibrationExample[]): string[] {
  const counts = new Map<string, number>();
  for (const example of examples) counts.set(example.source, (counts.get(example.source) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count >= minimumSourceExamples)
    .map(([source]) => source).sort();
}

/**
 * Fits a fresh calibration by full-batch logistic regression and reports pooled k-fold out-of-fold metrics for
 * it. Each fold selects its source columns from its own training rows, so the out-of-fold metrics never see a
 * column chosen with the validation fold's help. Deterministic for a given example order, so two processes
 * fitting the same rows agree byte for byte; asynchronous only to keep the event loop responsive while fitting.
 */
export async function fitPrefilterCalibration(examples: readonly CalibrationExample[],
  folds = 5): Promise<CalibrationFit> {
  let seed = 42;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const assignments = examples.map(() => Math.floor(random() * folds));
  const pooled: { score: number; label: boolean }[] = [];
  for (let fold = 0; fold < folds; fold++) {
    const training = examples.filter((_, index) => assignments[index] !== fold);
    const validation = examples.filter((_, index) => assignments[index] === fold);
    if (!training.length || !validation.length) continue;
    const foldSources = eligibleSources(training);
    const model = toCalibration(await descend(training, foldSources), foldSources);
    pooled.push(...validation.map((example) => ({
      score: calibratedMatchProbability(model, example), label: example.label })));
  }
  const sources = eligibleSources(examples);
  return {
    calibration: toCalibration(await descend(examples, sources), sources),
    candidate: evaluateOrdering(pooled),
    examples: examples.length,
    positives: examples.filter((example) => example.label).length,
  };
}
