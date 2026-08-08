import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calibratedMatchProbability, compareOnHoldout, evaluateCalibration, evaluateScores, fitPrefilterCalibration,
  parsePrefilterCalibration, type TrainingExample,
} from '../src/calibration.ts';

const calibration = parsePrefilterCalibration(JSON.stringify({
  version: 1, bias: -2, regexScore: 3, lexicalCosine: 1.5,
  sources: { hh: 0.5, habr: -1 }, ageBands: { month: -0.4, stale: -0.8 },
}));

test('the probability is monotonic in each evidence feature', () => {
  const base = { regexScore: 40, lexicalCosine: 0.1, source: 'hh', ageBand: 'week' as const };
  const p = calibratedMatchProbability(calibration, base);
  assert.ok(p > 0 && p < 1);
  assert.ok(calibratedMatchProbability(calibration, { ...base, regexScore: 80 }) > p);
  assert.ok(calibratedMatchProbability(calibration, { ...base, lexicalCosine: 0.3 }) > p);
  assert.ok(calibratedMatchProbability(calibration, { ...base, source: 'habr' }) < p);
  assert.ok(calibratedMatchProbability(calibration, { ...base, ageBand: 'stale' }) < p);
});

test('an unknown source or band is the reference class, never an error', () => {
  const base = { regexScore: 40, lexicalCosine: 0.1, source: 'hh', ageBand: 'week' as const };
  const unknown = calibratedMatchProbability(calibration, { ...base, source: 'brand-new-board' });
  assert.ok(unknown > 0 && unknown < 1);
  assert.ok(unknown < calibratedMatchProbability(calibration, base), 'hh carries a positive intercept');
});

test('feature clamping keeps out-of-range inputs inside the fitted domain', () => {
  const top = calibratedMatchProbability(calibration,
    { regexScore: 250, lexicalCosine: 9, source: 'hh', ageBand: 'today' });
  const bounded = calibratedMatchProbability(calibration,
    { regexScore: 100, lexicalCosine: 1, source: 'hh', ageBand: 'today' });
  assert.equal(top, bounded);
});

function syntheticExamples(): TrainingExample[] {
  // Two sources with opposite yields and evidence that genuinely separates: high regex on 'rich' is usually
  // good, everything on 'poor' is usually bad. Deterministic pseudo-noise keeps the fit honest.
  const examples: TrainingExample[] = [];
  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let index = 0; index < 400; index++) {
    const source = index % 2 === 0 ? 'rich' : 'poor';
    const regexScore = Math.round(random() * 100);
    const strong = regexScore > 50 && source === 'rich';
    examples.push({ regexScore, lexicalCosine: random() * 0.3, source, ageBand: 'week', scoredAt: index,
      label: strong ? random() < 0.8 : random() < 0.15 });
  }
  return examples;
}

test('the fit learns real structure and its held-out metrics beat a random ordering', async () => {
  const examples = syntheticExamples();
  const fit = await fitPrefilterCalibration(examples);
  assert.ok(fit.judgeable, 'a 400-row sample must leave a usable holdout');
  assert.ok(fit.candidate.auc > 0.7, `expected discriminative fit, auc=${fit.candidate.auc}`);
  assert.ok(fit.calibration.sources.rich! > fit.calibration.sources.poor!,
    'the richer source must earn the larger intercept');
  // The refit acceptance comparison: the fitted model evaluated as an incumbent scores the same examples.
  const incumbent = evaluateCalibration(fit.calibration, examples);
  assert.ok(incumbent.auc > 0.7);
  const coinFlip = evaluateScores(examples.map((_, index) => index % 100), examples);
  assert.ok(incumbent.auc > coinFlip.auc + 0.1, 'the model must clearly beat an arbitrary ordering');
});

test('the fit is deterministic for identical inputs', async () => {
  const examples = syntheticExamples();
  assert.deepEqual((await fitPrefilterCalibration(examples)).calibration,
    (await fitPrefilterCalibration(examples)).calibration);
});

test('malformed calibration JSON fails loudly at parse time', () => {
  assert.throws(() => parsePrefilterCalibration('not json'), /not valid JSON/);
  assert.throws(() => parsePrefilterCalibration(JSON.stringify({ version: 2 })), /invalid/);
  assert.throws(() => parsePrefilterCalibration(JSON.stringify({
    version: 1, bias: Number.NaN, regexScore: 0, lexicalCosine: 0, sources: {}, ageBands: {},
  })), /invalid/);
});

test('a version 1 document still parses and serves exactly as before', () => {
  // The live deployment is serving a v1 calibration; adding features must not change one of its predictions.
  const v1 = parsePrefilterCalibration(JSON.stringify({
    version: 1, bias: -2, regexScore: 3, lexicalCosine: 1.5,
    sources: { hh: 0.5 }, ageBands: { month: -0.4 },
  }));
  assert.equal(v1.version, 1);
  assert.equal(v1.titleSimilarity, 0);
  assert.equal(v1.skillCoverage, 0);
  const features = { regexScore: 40, lexicalCosine: 0.1, source: 'hh', ageBand: 'week' as const };
  const without = calibratedMatchProbability(v1, features);
  // The new evidence must move nothing while the coefficients for it are absent.
  assert.equal(calibratedMatchProbability(v1, { ...features, titleSimilarity: 1, skillCoverage: 1 }), without);
});

test('a version 2 document weighs the split evidence the old one could not see', () => {
  const v2 = parsePrefilterCalibration(JSON.stringify({
    version: 2, bias: -2, regexScore: 1, lexicalCosine: 1,
    titleSimilarity: 2.5, skillCoverage: 1.5, sources: {}, ageBands: {},
  }));
  const base = { regexScore: 40, lexicalCosine: 0.1, source: 'hh', ageBand: 'week' as const };
  const plain = calibratedMatchProbability(v2, base);
  assert.ok(calibratedMatchProbability(v2, { ...base, titleSimilarity: 1 }) > plain);
  assert.ok(calibratedMatchProbability(v2, { ...base, skillCoverage: 1 }) > plain);
  // Out-of-range evidence is clamped rather than trusted, so a bad row cannot dominate the logit.
  assert.equal(calibratedMatchProbability(v2, { ...base, titleSimilarity: 5 }),
    calibratedMatchProbability(v2, { ...base, titleSimilarity: 1 }));
});

test('a fresh fit emits the current version and can learn from the split evidence alone', async () => {
  // regexScore and cosine are held constant, so only the new columns carry the signal: if the fit can separate
  // these it is genuinely reading them.
  const examples: TrainingExample[] = [];
  let seed = 11;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let index = 0; index < 400; index++) {
    const strong = index % 2 === 0;
    examples.push({ regexScore: 50, lexicalCosine: 0.15, source: 'hh', ageBand: 'week', scoredAt: index,
      titleSimilarity: strong ? 0.8 : 0.1, skillCoverage: strong ? 0.9 : 0.05,
      label: strong ? random() < 0.85 : random() < 0.15 });
  }
  const fit = await fitPrefilterCalibration(examples);
  assert.equal(fit.calibration.version, 3);
  assert.ok(fit.calibration.titleSimilarity > 0 || fit.calibration.skillCoverage > 0,
    'the split evidence must earn positive weight when it is the only signal');
  assert.ok(fit.candidate.auc > 0.75, `expected a discriminative fit, auc=${fit.candidate.auc}`);
});

test('the holdout is the newest rows, whatever order they arrive in', async () => {
  // Shuffled input: the split must follow scoredAt, not the caller's array order, or the "future" it validates
  // against is just an arbitrary quarter of the corpus.
  const examples = syntheticExamples().map((example, index) => ({ ...example, scoredAt: 1_000 - index }));
  const fit = await fitPrefilterCalibration(examples, { holdoutShare: 0.25 });
  assert.equal(fit.holdoutIndices.length, 100);
  const heldOut = new Set(fit.holdoutIndices);
  // scoredAt descends with the index, so the newest quarter is the first hundred entries.
  for (let index = 0; index < 100; index++) assert.ok(heldOut.has(index), `index ${index} must be held out`);
});

test('a corpus too small to validate is never adopted', async () => {
  const examples = syntheticExamples().slice(0, 40);
  const fit = await fitPrefilterCalibration(examples);
  assert.equal(fit.judgeable, false, 'a 10-row holdout cannot justify a refit');
  assert.ok(Number.isNaN(fit.candidate.auc));
  // The document is still produced, so a caller may bootstrap from it deliberately; it just is not self-adopting.
  assert.equal(fit.calibration.version, 3);
});

test('judge and user intercepts are fitted but never served', async () => {
  // The judge is decided after the match is scored and the user is constant within their own queue, so neither
  // may touch a served probability; they exist only to keep a strict judge out of the evidence coefficients.
  const examples: TrainingExample[] = [];
  let seed = 3;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let index = 0; index < 600; index++) {
    const strict = index % 2 === 0;
    const strong = random() < 0.5;
    examples.push({ regexScore: strong ? 80 : 20, lexicalCosine: 0.15, source: 'hh', ageBand: 'week',
      scoredAt: index, judge: strict ? 'strict-judge' : 'lenient-judge', user: 'u1',
      // The lenient judge says yes far more often at identical evidence.
      label: strict ? random() < (strong ? 0.3 : 0.05) : random() < (strong ? 0.9 : 0.5) });
  }
  const fit = await fitPrefilterCalibration(examples);
  assert.ok(fit.calibration.judges['lenient-judge']! > fit.calibration.judges['strict-judge']!,
    'the lenient judge must earn the larger intercept');
  assert.ok(fit.calibration.users.u1 !== undefined, 'a user with enough rows earns an intercept');
  // Serving ignores both: a probability cannot depend on a judge that has not run yet.
  const features = { regexScore: 80, lexicalCosine: 0.15, source: 'hh', ageBand: 'week' as const };
  const served = calibratedMatchProbability(fit.calibration, features);
  const withJudge = calibratedMatchProbability(
    { ...fit.calibration, judges: { 'strict-judge': -5, 'lenient-judge': 5 } }, features);
  assert.equal(served, withJudge);
});

test('a version 3 document without judges or users still parses', () => {
  const parsed = parsePrefilterCalibration(JSON.stringify({
    version: 3, bias: -1, regexScore: 2, lexicalCosine: 1, sources: {}, ageBands: {},
  }));
  assert.deepEqual(parsed.judges, {});
  assert.deepEqual(parsed.users, {});
});

test('the acceptance gate refuses a difference it cannot distinguish from noise', () => {
  // Same ordering quality, different arbitrary scales: the paired bootstrap must see a delta around zero.
  const labels = Array.from({ length: 200 }, (_, index) => index % 3 === 0);
  const candidate = labels.map((label, index) => (label ? 0.7 : 0.3) + (index % 7) / 100);
  const identical = compareOnHoldout(candidate, candidate, labels);
  assert.equal(identical.accepted, true, 'an identical ordering is not a regression');
  assert.ok(Math.abs(identical.deltaAuc) < 1e-9);

  // A genuinely worse candidate must be refused, and the refusal must name the interval.
  const shuffled = labels.map((_, index) => ((index * 37) % 200) / 200);
  const worse = compareOnHoldout(shuffled, candidate, labels);
  assert.equal(worse.accepted, false);
  assert.ok(worse.deltaAucLower < -0.01);
  assert.match(worse.reason, /lower bound/);
});

test('a single-class holdout is refused rather than scored', () => {
  const labels = Array.from({ length: 50 }, () => true);
  const scores = labels.map((_, index) => index / 50);
  const verdict = compareOnHoldout(scores, scores, labels);
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reason, /single-class/);
});
