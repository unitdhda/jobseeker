import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSourceKey,
  parseUserId,
  type SearchPlan,
  type SourceKey,
  type UserId,
} from '../src/contracts.ts';
import { unitIdentityOf } from '../src/identity.ts';
import {
  matchVacancy,
  nextWakeMs,
  runSchedulerTick,
  type MatchEvidence,
  type TickUnit,
} from '../src/runtime.ts';

test('scheduler builds one fair plan per platform and isolates provider failure', async () => {
  const alpha = parseSourceKey('alpha');
  const beta = parseSourceKey('beta');
  const one = parseUserId('1');
  const two = parseUserId('2');
  const now = new Date('2026-01-01T12:00:00Z');
  const make = (platform: SourceKey, text: string, users: UserId[], nextRunAt: string): TickUnit => ({
    unitId: unitIdentityOf(platform, { text }).unitId,
    platform,
    query: { name: text, text },
    cadenceMinutes: 60,
    subscribers: users.map((userId) => ({ userId, searchName: text })),
    nextRunAt: new Date(nextRunAt),
  });
  const due = [
    make(alpha, 'shared', [one, two], '2026-01-01T10:00:00Z'),
    make(alpha, 'one', [one], '2026-01-01T09:00:00Z'),
    make(beta, 'failure', [two], '2026-01-01T08:00:00Z'),
  ];
  const plans = new Map<string, SearchPlan<unknown>>();
  const updates: Array<{ novelty: boolean; cadence: number }> = [];
  const report = await runSchedulerTick({
    cadencePolicy: { floorMinutes: 15, ceilingMinutes: 240 },
    queriesPerUserPerTick: 1,
    platformConcurrency: 2,
    dueUnits: async () => due,
    discover: async (platform, plan) => {
      plans.set(platform, plan);
      if (platform === beta) throw new Error('unavailable');
      return { searches: 2, users: 2, seen: 3, discovered: 1, discoveredBySearch: { shared: 1, one: 0 } };
    },
    recordUnitRun: async (_unitId, cadence, novelty) => { updates.push({ novelty, cadence }); },
  }, now);

  assert.equal(plans.get(alpha)?.searches.length, 2);
  assert.equal(report.platformFailures, 1);
  assert.deepEqual(report.successfulPlatforms, ['alpha']); assert.deepEqual(report.failedPlatforms, ['beta']);
  assert.deepEqual(report.perPlatform.beta, { selected: 1, unitsRun: 0, discovered: 0, failed: true });
  assert.deepEqual(report.perPlatform.alpha, { selected: 2, unitsRun: 2, discovered: 1, failed: false });
  assert.equal(report.unitsRun, 2);
  assert.deepEqual(updates.map((entry) => entry.cadence).sort((a, b) => a - b), [30, 90]);
});

test('wake delay remains between fifteen seconds and five minutes', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  assert.equal(nextWakeMs([], now), 300_000);
  assert.equal(nextWakeMs([{ nextRunAt: new Date(now.getTime() - 1) }], now), 15_000);
  assert.equal(nextWakeMs([{ nextRunAt: new Date(now.getTime() + 999_999) }], now), 300_000);
});

test('match-on-ingest isolates one user lens and persists only evidence above floor', async () => {
  const one = parseUserId('1');
  const two = parseUserId('2');
  const evidence: MatchEvidence = {
    score: 80, regexScore: 75, lexicalCosine: 0.2, titleSimilarity: 0.8,
    skillCoverage: 0.5, seniorityGap: null, specificity: null, lexicalCosineIdf: null,
  };
  let written = 0;
  const report = await matchVacancy({
    approvedUserIds: async () => [one, two],
    lexicalScore: async (userId) => userId === one ? evidence : Promise.reject(new Error('broken lens')),
    matchFloor: 70,
    createMatches: async (candidates) => { written = candidates.length; return candidates.length; },
  }, { vacancyId: 42 }, new Date());
  assert.deepEqual(report, { evaluated: 2, matched: 1, failures: 1 });
  assert.equal(written, 1);
});
