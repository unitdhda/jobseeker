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

test('v4 prescore prompt calibrates every band around the configured threshold and states the exact contract', () => {
  const forty = prescoringSystemPrompt(40); const fifty = prescoringSystemPrompt(50);
  assert.match(forty, /rubric v4/u); assert.match(forty, /same profession and responsibility set/u);
  assert.match(forty, /seniority and required years fit in both directions/iu);
  assert.match(forty, /0–19.*20–39.*40–69.*70–84.*85–100/su);
  assert.match(fifty, /0–29.*30–49.*50–79.*80–94.*95–100/su);
  assert.match(fifty, /Score 50 is the configured full-scoring admission threshold/u);
  assert.match(fifty, /Missing salary is neutral/u);
  assert.match(fifty, /"results".*"vacancyId".*"score".*"rationale"/su);
  assert.throws(() => prescoringSystemPrompt(40.5), /integer/u);
  assert.throws(() => prescoringSystemPrompt(101), /0 through 100/u);
});
