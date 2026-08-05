import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineLoop, drainScoring, runLoopIteration, type LoopPorts, type ScoringPorts } from '../src/engine-loop.ts';

function loopFixture(overrides: Partial<LoopPorts> = {}): { ports: LoopPorts; calls: string[] } {
  const calls: string[] = [];
  const ports: LoopPorts = {
    tick: async () => { calls.push('tick'); return { due: 2, unitsRun: 2, platformFailures: 0, perPlatform: {} }; },
    normalize: async () => { calls.push('normalize'); return { vacancyIds: [11, 12], failed: 0, closed: 0 }; },
    matchVacancies: async (vacancyIds) => { calls.push(`match:${vacancyIds.join(',')}`); return { matched: 3, failures: 0 }; },
    scoreDue: async () => { calls.push('score'); return { users: 2, drained: 2, skippedOverBudget: 0, failures: 0 }; },
    deliver: async () => { calls.push('deliver'); },
    ...overrides,
  };
  return { ports, calls };
}

test('an iteration runs the stages in pipeline order and hands new vacancies to matching', async () => {
  const { ports, calls } = loopFixture();
  const report = await runLoopIteration(ports, new Date(0));
  assert.deepEqual(calls, ['tick', 'normalize', 'match:11,12', 'score', 'deliver']);
  assert.deepEqual(report.stageFailures, []);
  assert.equal(report.matched, 3);
});

test('nothing normalized means matching is not invoked at all', async () => {
  const { ports, calls } = loopFixture({
    normalize: async () => { calls.push('normalize'); return { vacancyIds: [], failed: 1, closed: 2 }; },
  });
  await runLoopIteration(ports, new Date(0));
  assert.ok(!calls.some((entry) => entry.startsWith('match')), 'match stage skipped');
  assert.ok(calls.includes('score'), 'later stages still run');
});

test('a stage that throws is recorded and does not stop the stages behind it', async () => {
  const { ports, calls } = loopFixture({
    tick: async () => { throw new Error('scheduler storage is down'); },
    normalize: async () => { throw new Error('normalizer is down'); },
  });
  const report = await runLoopIteration(ports, new Date(0));
  assert.deepEqual(report.stageFailures, ['tick', 'normalize']);
  assert.deepEqual(calls, ['score', 'deliver'], 'scoring and delivery still ran');
});

function scoringFixture(spent: Record<string, number>): { ports: ScoringPorts; drained: string[] } {
  const drained: string[] = [];
  const ports: ScoringPorts = {
    scoringUserIds: async () => Object.keys(spent),
    spentTodayUsd: async (userId) => spent[userId]!,
    drainUser: async (userId, limit) => { drained.push(`${userId}:${limit}`); return { attempted: limit, completed: limit }; },
  };
  return { ports, drained };
}

test('the scoring drain skips users at or over their daily budget and drains the rest with the claim limit', async () => {
  const { ports, drained } = scoringFixture({ u1: 0.10, u2: 2.00, u3: 1.99 });
  const report = await drainScoring(ports, { dailyBudgetUsd: 2.00, claimLimit: 5 }, new Date(0));
  assert.deepEqual(drained, ['u1:5', 'u3:5'], 'u2 has spent the whole budget');
  assert.equal(report.skippedOverBudget, 1);
  assert.equal(report.drained, 2);
});

test('one user\'s scoring failure does not cost the others their drain', async () => {
  const { ports, drained } = scoringFixture({ u1: 0, u2: 0, u3: 0 });
  ports.drainUser = async (userId, limit) => {
    if (userId === 'u2') throw new Error('scoring agent crashed');
    drained.push(`${userId}:${limit}`);
    return { attempted: limit, completed: limit };
  };
  const report = await drainScoring(ports, { dailyBudgetUsd: 1, claimLimit: 3 }, new Date(0));
  assert.deepEqual(drained, ['u1:3', 'u3:3']);
  assert.equal(report.failures, 1);
});

test('a budget-lookup failure skips only that user, never the whole drain', async () => {
  const { ports, drained } = scoringFixture({ u1: 0, u2: 0 });
  ports.spentTodayUsd = async (userId) => {
    if (userId === 'u1') throw new Error('accounts table unreachable');
    return 0;
  };
  const report = await drainScoring(ports, { dailyBudgetUsd: 1, claimLimit: 3 }, new Date(0));
  assert.deepEqual(drained, ['u2:3']);
  assert.equal(report.failures, 1);
});

test('the loop keeps iterating with the wake pause between rounds and stops when told to', async () => {
  const sleeps: number[] = [];
  let iterations = 0;
  const { ports } = loopFixture({
    tick: async () => { iterations += 1; return { due: 0, unitsRun: 0, platformFailures: 0, perPlatform: {} }; },
  });
  const loop = createEngineLoop(ports, {
    nextWakeMs: async () => 42,
    sleep: async (ms) => { sleeps.push(ms); if (iterations >= 3) loop.stop(); },
  });
  await loop.run();
  assert.equal(iterations, 3);
  assert.deepEqual(sleeps, [42, 42, 42], 'every round ends with the wake pause');
});

test('an iteration that throws outright does not kill the loop', async () => {
  let calls = 0;
  const ports: LoopPorts = {
    // Every stage failing produces a report, so only a ports-construction bug can throw; simulate it.
    tick: async () => { calls += 1; throw new Error('boom'); },
    normalize: async () => { throw new Error('boom'); },
    matchVacancies: async () => { throw new Error('boom'); },
    scoreDue: async () => { throw new Error('boom'); },
    deliver: async () => { throw new Error('boom'); },
  };
  const loop = createEngineLoop(ports, {
    nextWakeMs: async () => { throw new Error('even the wake estimate fails'); },
    sleep: async () => { if (calls >= 2) loop.stop(); },
  });
  await loop.run();
  assert.ok(calls >= 2, 'the loop survived complete port failure and kept going');
});
