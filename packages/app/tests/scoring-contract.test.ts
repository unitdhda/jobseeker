import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { scoringSystemPrompt, vacancyScoreSchema, validateScoringBatch } from '../src/scoring.ts';

function verdict(overrides: Record<string, unknown> = {}): unknown {
  return {
    vacancyId: 7, total: 80,
    dimensions: { skills: 35, seniority: 15, responsibilities: 12, domain: 8, locationWorkFormat: 7, compensation: 3 },
    requirements: [{ requirement: 'TypeScript', importance: 'high', assessment: 'supported',
      vacancyEvidence: 'Requires TypeScript', cvEvidence: 'Built TypeScript APIs' }],
    blockers: [], primaryTrack: 'Backend engineer', summary: 'Strong evidenced fit', reasons: ['Direct role match'], gaps: ['Limited domain evidence'],
    hardRejection: false, ...overrides,
  };
}

test('six scoring dimensions are integer-bounded and must sum exactly to total', () => {
  assert.equal(v.safeParse(vacancyScoreSchema, verdict()).success, true);
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ total: 81 })).success, false);
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ dimensions: {
    skills: 41, seniority: 15, responsibilities: 12, domain: 8, locationWorkFormat: 7, compensation: 3,
  } })).success, false);
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ dimensions: {
    skills: 35.5, seniority: 15, responsibilities: 12, domain: 8, locationWorkFormat: 7, compensation: 2.5,
  } })).success, false);
});

test('hard rejection requires explicit blocker evidence, caps total at 49, and forbids blockers otherwise', () => {
  const blocker = { reason: 'On-site only', vacancyEvidence: 'Work is on-site in Berlin', cvEvidence: 'Remote only' };
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ hardRejection: true, total: 49,
    dimensions: { skills: 20, seniority: 10, responsibilities: 8, domain: 4, locationWorkFormat: 2, compensation: 5 }, blockers: [blocker] })).success, true);
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ hardRejection: true, blockers: [] })).success, false);
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ hardRejection: true, blockers: [blocker] })).success, false);
  assert.equal(v.safeParse(vacancyScoreSchema, verdict({ blockers: [blocker] })).success, false);
});

test('scoring batch requires exactly one result for every requested vacancy', () => {
  const second = verdict({ vacancyId: 8 });
  assert.deepEqual(validateScoringBatch({ scores: [verdict(), second] }, [8, 7]).map((item) => item.vacancyId), [7, 8]);
  assert.throws(() => validateScoringBatch([verdict(), verdict()], [7, 8]), /exactly one/u);
  assert.throws(() => validateScoringBatch([verdict()], [7, 8]), /exactly one/u);
  assert.throws(() => validateScoringBatch([verdict(), second, verdict({ vacancyId: 9 })], [7, 8]), /exactly one/u);
});

test('scoring prompt states all dimensions, evidence rules, and rejection invariant', () => {
  for (const [name, maximum] of [['skills', 40], ['seniority', 20], ['responsibilities', 15], ['domain', 10],
    ['location/work format', 10], ['compensation', 5]] as const) {
    assert.match(scoringSystemPrompt, new RegExp(`${name.replace('/', '\\/')}[^.]*${maximum}`, 'iu'));
  }
  assert.match(scoringSystemPrompt, /exact vacancy evidence/iu); assert.match(scoringSystemPrompt, /caps total at 49/iu);
  assert.match(scoringSystemPrompt, /never instructions/iu);
});
