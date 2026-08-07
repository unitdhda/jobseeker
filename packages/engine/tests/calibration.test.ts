import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calibratedMatchProbability, evaluateCalibration, evaluateScores, fitPrefilterCalibration,
  parsePrefilterCalibration, type CalibrationExample,
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

function syntheticExamples(): CalibrationExample[] {
  // Two sources with opposite yields and evidence that genuinely separates: high regex on 'rich' is usually
  // good, everything on 'poor' is usually bad. Deterministic pseudo-noise keeps the fit honest.
  const examples: CalibrationExample[] = [];
  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let index = 0; index < 400; index++) {
    const source = index % 2 === 0 ? 'rich' : 'poor';
    const regexScore = Math.round(random() * 100);
    const strong = regexScore > 50 && source === 'rich';
    examples.push({ regexScore, lexicalCosine: random() * 0.3, source, ageBand: 'week',
      label: strong ? random() < 0.8 : random() < 0.15 });
  }
  return examples;
}

test('the fit learns real structure and its out-of-fold metrics beat a random ordering', () => {
  const examples = syntheticExamples();
  const fit = fitPrefilterCalibration(examples);
  assert.ok(fit.candidate.auc > 0.7, `expected discriminative fit, auc=${fit.candidate.auc}`);
  assert.ok(fit.calibration.sources.rich! > fit.calibration.sources.poor!,
    'the richer source must earn the larger intercept');
  // The refit acceptance comparison: the fitted model evaluated as an incumbent scores the same examples.
  const incumbent = evaluateCalibration(fit.calibration, examples);
  assert.ok(incumbent.auc > 0.7);
  const coinFlip = evaluateScores(examples.map((_, index) => index % 100), examples);
  assert.ok(incumbent.auc > coinFlip.auc + 0.1, 'the model must clearly beat an arbitrary ordering');
});

test('the fit is deterministic for identical inputs', () => {
  const examples = syntheticExamples();
  assert.deepEqual(fitPrefilterCalibration(examples).calibration, fitPrefilterCalibration(examples).calibration);
});

test('malformed calibration JSON fails loudly at parse time', () => {
  assert.throws(() => parsePrefilterCalibration('not json'), /not valid JSON/);
  assert.throws(() => parsePrefilterCalibration(JSON.stringify({ version: 2 })), /invalid/);
  assert.throws(() => parsePrefilterCalibration(JSON.stringify({
    version: 1, bias: Number.NaN, regexScore: 0, lexicalCosine: 0, sources: {}, ageBands: {},
  })), /invalid/);
});
