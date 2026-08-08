import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEngineLoop, drainScoring, runDiscoveryIteration, runJudgmentIteration,
  type DiscoveryPorts, type JudgmentPorts, type LoopPorts, type ScoringPorts,
} from '@jobseeker/engine';

function discoveryFixture(overrides: Partial<DiscoveryPorts> = {}): { ports: DiscoveryPorts; calls: string[] } {
  const calls: string[] = [];
  const ports: DiscoveryPorts = {
    tick: async () => { calls.push('tick'); return { due: 2, unitsRun: 2, platformFailures: 0, perPlatform: {} }; },
    normalize: async () => { calls.push('normalize'); return { vacancyIds: [11, 12], failed: 0, closed: 0, expired: 0, selected: 2, refreshed: 0, normalized: 2, bySource: {} }; },
    matchVacancies: async (vacancyIds) => { calls.push(`match:${vacancyIds.join(',')}`); return { matched: 3, failures: 0 }; },
    ...overrides,
  };
  return { ports, calls };
}
function judgmentFixture(overrides: Partial<JudgmentPorts> = {}): { ports: JudgmentPorts; calls: string[] } {
  const calls: string[] = [];
  const ports: JudgmentPorts = {
    scoreDue: async () => { calls.push('score'); return { users: 2, drained: 2, skippedOverBudget: 0, failures: 0 }; },
    deliver: async () => { calls.push('deliver'); },
    ...overrides,
  };
  return { ports, calls };
}

test('discovery runs tick, normalize, match in order and hands over the new vacancies', async () => {
  const { ports, calls } = discoveryFixture();
  const report = await runDiscoveryIteration(ports, new Date(0));
  assert.deepEqual(calls, ['tick', 'normalize', 'match:11,12']);
  assert.deepEqual(report.stageFailures, []);
  assert.equal(report.matched, 3);
});

test('nothing normalized means matching is not invoked at all', async () => {
  const { ports, calls } = discoveryFixture({
    normalize: async () => { calls.push('normalize'); return { vacancyIds: [], failed: 1, closed: 2, expired: 0, selected: 3, refreshed: 0, normalized: 0, bySource: {} }; },
  });
  await runDiscoveryIteration(ports, new Date(0));
  assert.ok(!calls.some((entry) => entry.startsWith('match')));
});

test('a discovery stage that throws is recorded and does not stop the stages behind it', async () => {
  const { ports, calls } = discoveryFixture({ tick: async () => { throw new Error('scheduler storage down'); } });
  const report = await runDiscoveryIteration(ports, new Date(0));
  assert.deepEqual(report.stageFailures, ['tick']);
  assert.ok(calls.includes('normalize'), 'normalization still ran');
});

test('judgment runs scoring then delivery, and a scoring failure never blocks delivery', async () => {
  const { ports, calls } = judgmentFixture({ scoreDue: async () => { throw new Error('claims unreachable'); } });
  const report = await runJudgmentIteration(ports, new Date(0));
  assert.deepEqual(report.stageFailures, ['score']);
  assert.deepEqual(calls, ['deliver']);
});

test('retirement and calibration run after delivery, and neither can hold up an alert', async () => {
  const { ports, calls } = judgmentFixture({
    retire: async () => { calls.push('retire'); return 7; },
    calibrate: async () => { calls.push('calibrate'); },
  });
  const report = await runJudgmentIteration(ports, new Date(0));
  assert.deepEqual(calls, ['score', 'deliver', 'retire', 'calibrate']);
  assert.equal(report.retired, 7);
  assert.deepEqual(report.stageFailures, []);
});

test('a retirement failure is recorded without costing the calibration its turn', async () => {
  const { ports, calls } = judgmentFixture({
    retire: async () => { throw new Error('update deadlocked'); },
    calibrate: async () => { calls.push('calibrate'); },
  });
  const report = await runJudgmentIteration(ports, new Date(0));
  assert.deepEqual(report.stageFailures, ['retire']);
  assert.equal(report.retired, undefined);
  assert.ok(calls.includes('calibrate'), 'the later stage still ran');
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
const policy = { dailyBudgetUsd: 2.40, claimLimit: 5, paceFloorFraction: 1 / 12 };
const atUtc = (hours: number) => new Date(Date.UTC(2026, 7, 6, hours, 0, 0));

test('the budget accrues through the day: what a capped user cannot spend at dawn they can by evening', async () => {
  // 2.40/day at 06:00 UTC allows 0.60; at 18:00 it allows 1.80.
  const spent = { early: 0.70, late: 0.70 };
  const morning = scoringFixture(spent);
  await drainScoring(morning.ports, policy, atUtc(6));
  assert.deepEqual(morning.drained, [], 'both users are ahead of the 06:00 allowance');
  const evening = scoringFixture(spent);
  await drainScoring(evening.ports, policy, atUtc(18));
  assert.equal(evening.drained.length, 2, 'the same spend is under the 18:00 allowance');
});

test('the floor fraction keeps the first hours of the day from being starved', async () => {
  const { ports, drained } = scoringFixture({ u1: 0.10 });
  await drainScoring(ports, policy, atUtc(0));
  assert.deepEqual(drained, ['u1:5'], '1/12 of the day is allowed from midnight');
});

test('near midnight the paced ceiling is the whole daily budget', async () => {
  const under = scoringFixture({ u1: 2.30 });
  await drainScoring(under.ports, policy, new Date(Date.UTC(2026, 7, 6, 23, 59, 0)));
  assert.equal(under.drained.length, 1);
  const over = scoringFixture({ u1: 2.45 });
  const report = await drainScoring(over.ports, policy, new Date(Date.UTC(2026, 7, 6, 23, 59, 0)));
  assert.equal(over.drained.length, 0);
  assert.equal(report.skippedOverBudget, 1);
});

test('one user\'s scoring failure does not cost the others their drain', async () => {
  const { ports, drained } = scoringFixture({ u1: 0, u2: 0, u3: 0 });
  ports.drainUser = async (userId, limit) => {
    if (userId === 'u2') throw new Error('scoring agent crashed');
    drained.push(`${userId}:${limit}`);
    return { attempted: limit, completed: limit };
  };
  const report = await drainScoring(ports, policy, atUtc(12));
  assert.deepEqual(drained, ['u1:5', 'u3:5']);
  assert.equal(report.failures, 1);
});

test('the two lanes run on their own clocks: judgment keeps judging while discovery is stuck in one long pass', async () => {
  let discoveries = 0; let judgments = 0;
  const discovery = discoveryFixture({
    normalize: async () => { // one endless normalization pass
      discoveries += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { vacancyIds: [], failed: 0, closed: 0, expired: 0, selected: 0, refreshed: 0, normalized: 0, bySource: {} };
    },
  });
  const judgment = judgmentFixture({
    scoreDue: async () => { judgments += 1; return { users: 0, drained: 0, skippedOverBudget: 0, failures: 0 }; },
  });
  const ports: LoopPorts = { ...discovery.ports, ...judgment.ports };
  const loop = createEngineLoop(ports, {
    discovery: { nextWakeMs: async () => 10, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    judgment: { nextWakeMs: async () => 20, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  });
  const running = loop.run();
  await new Promise((resolve) => setTimeout(resolve, 250));
  loop.stop();
  await running;
  assert.ok(judgments >= 3, `judgment iterated while discovery blocked (judgments=${judgments})`);
  assert.ok(discoveries >= 1);
});

test('stopping stops both lanes and total port failure kills neither', async () => {
  let calls = 0;
  const ports: LoopPorts = {
    tick: async () => { calls += 1; throw new Error('boom'); },
    normalize: async () => { throw new Error('boom'); },
    matchVacancies: async () => { throw new Error('boom'); },
    scoreDue: async () => { calls += 1; throw new Error('boom'); },
    deliver: async () => { throw new Error('boom'); },
  };
  const loop = createEngineLoop(ports, {
    discovery: { nextWakeMs: async () => { throw new Error('no estimate'); }, sleep: () => new Promise((resolve) => setTimeout(resolve, 10)) },
    judgment: { nextWakeMs: async () => 10, sleep: () => new Promise((resolve) => setTimeout(resolve, 10)) },
  });
  const running = loop.run();
  await new Promise((resolve) => setTimeout(resolve, 120));
  loop.stop();
  await running;
  assert.ok(calls >= 4, 'both lanes kept iterating through complete failure');
});
