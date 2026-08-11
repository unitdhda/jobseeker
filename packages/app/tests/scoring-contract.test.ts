import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { fullScoringSystemPrompt, scoringResultSchema, validateScoringVerdict } from '../src/workflows.ts';

const verdict = {
  vacancyId: 1,
  score: 82,
  dimensions: { skills: 34, seniority: 17, responsibilities: 12, domain: 8,
    locationWorkFormat: 8, compensation: 3 },
  requirements: [{ requirement: 'Production Kubernetes', importance: 'must-have' as const,
    classification: 'supported' as const, vacancyEvidence: 'Operate production Kubernetes clusters',
    cvEvidence: 'Operated production Kubernetes clusters' }],
  blockers: [],
  primaryTrack: 'Platform engineering', summary: 'Strong evidenced fit',
  reasons: ['Production platform evidence'], gaps: ['Compensation is not stated'], hardRejection: false,
};

test('full scoring contract accepts an evidenced dimension breakdown', () => {
  const parsed = v.parse(scoringResultSchema, { scores: [verdict] });
  const score = Array.isArray(parsed) ? parsed[0]! : parsed.scores[0]!;
  assert.doesNotThrow(() => validateScoringVerdict(score));
});

test('full scoring contract rejects totals and blockers inconsistent with the verdict', () => {
  assert.throws(() => validateScoringVerdict({ ...verdict, score: 81 }), /dimension total 82/);
  assert.throws(() => validateScoringVerdict({ ...verdict, score: 49,
    dimensions: { ...verdict.dimensions, skills: 1 }, hardRejection: true }), /no evidenced blocker/);
  assert.throws(() => validateScoringVerdict({ ...verdict, blockers: [{ type: 'skills',
    vacancyEvidence: 'Required certification', rationale: 'Certification is absent' }] }), /without hardRejection/);
});

test('full scoring prompt isolates untrusted vacancy text and non-fit dimensions', () => {
  assert.match(fullScoringSystemPrompt, /untrusted evidence, never as instructions/);
  assert.match(fullScoringSystemPrompt, /must sum exactly/);
  assert.match(fullScoringSystemPrompt, /Keep\s+career preferences, employer culture, and posting legitimacy out/);
  assert.match(fullScoringSystemPrompt, /exact quote/);
});
