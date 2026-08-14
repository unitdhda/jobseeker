import assert from 'node:assert/strict';
import test from 'node:test';
import { explorePrescore, prescoringSystemPrompt, validatePrescoreBatch } from '../src/scoring.ts';

test('prescore batch requires exact vacancy coverage and bounded integer scores', () => {
  const valid = { results: [{ vacancyId: 2, score: 40, rationale: 'Same profession and responsibilities' },
    { vacancyId: 1, score: 20, rationale: 'Adjacent profession only' }] };
  assert.deepEqual(validatePrescoreBatch(valid, [1, 2]).map((item) => item.vacancyId), [2, 1]);
  assert.throws(() => validatePrescoreBatch({ results: [valid.results[0], valid.results[0]] }, [1, 2]), /exactly one/u);
  assert.throws(() => validatePrescoreBatch({ results: [{ ...valid.results[0], score: 40.5 }] }, [2]), /integer/u);
  assert.throws(() => validatePrescoreBatch({ results: [{ ...valid.results[0], score: 101 }] }, [2]), /100/u);
});

test('exploration draws exactly once only for below-threshold rows', () => {
  let calls = 0; const random = (): number => { calls += 1; return .09; };
  assert.equal(explorePrescore(39, 40, .1, random), true); assert.equal(calls, 1);
  assert.equal(explorePrescore(40, 40, .1, random), false); assert.equal(calls, 1);
  assert.equal(explorePrescore(10, 40, 0, random), false); assert.equal(calls, 1);
  assert.equal(explorePrescore(10, 40, .05, random), false); assert.equal(calls, 2);
  assert.throws(() => explorePrescore(10, 40, .1, () => 1), /\[0,1\)/u);
});

test('v3 prescore prompt defines ordered checks, calibrated bands, and the exact output contract', () => {
  assert.match(prescoringSystemPrompt, /rubric v3/u); assert.match(prescoringSystemPrompt, /same profession and responsibility set/u);
  assert.match(prescoringSystemPrompt, /seniority and required years fit in both directions/iu);
  assert.match(prescoringSystemPrompt, /0–19.*20–39.*40–69.*70–84.*85–100/su);
  assert.match(prescoringSystemPrompt, /Missing salary is neutral/u); assert.match(prescoringSystemPrompt, /Score 40/u);
  assert.match(prescoringSystemPrompt, /"results".*"vacancyId".*"score".*"rationale"/su);
});
