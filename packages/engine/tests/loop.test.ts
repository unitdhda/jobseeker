import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '../src/contracts.ts';
import {
  createEngineLoop,
  drainScoring,
  runDiscoveryIteration,
  runJudgmentIteration,
  type LoopPorts,
} from '../src/loop.ts';

const emptyTick = {
  due: 0, unitsRun: 0, platformFailures: 0, unitUpdateFailures: 0,
  successfulPlatforms: [], failedPlatforms: [], perPlatform: {},
};

test('discovery and judgment preserve stage order while isolating failures', async () => {
  const order: string[] = [];
  const discovery = await runDiscoveryIteration({
    tick: async () => { order.push('tick'); throw new Error('transient'); },
    normalize: async () => {
      order.push('normalize');
      return { vacancyIds: [1], failed: 0, closed: 0, expired: 0, selected: 1, refreshed: 0, normalized: 1,
        selectionFailures: 0, maintenanceFailures: 0, bySource: {} };
    },
    matchVacancies: async () => { order.push('match'); return { matched: 1, failures: 0 }; },
  }, new Date());
  assert.deepEqual(order, ['tick', 'normalize', 'match']);
  assert.deepEqual(discovery.stageFailures, ['tick']);

  order.length = 0;
  const judgment = await runJudgmentIteration({
    scoreDue: async () => { order.push('score'); throw new Error('transient'); },
    deliver: async () => { order.push('deliver'); },
    retire: async () => { order.push('retire'); return 2; },
    maintain: async () => { order.push('maintain'); },
  }, new Date());
  assert.deepEqual(order, ['score', 'deliver', 'retire', 'maintain']);
  assert.deepEqual(judgment.stageFailures, ['score']);
  assert.equal(judgment.retired, 2);
});

test('scoring uses an independent UTC-day-paced ceiling for every user', async () => {
  const one = parseUserId('1');
  const two = parseUserId('2');
  const drained: string[] = [];
  const report = await drainScoring({
    scoringUserIds: async () => [one, two],
    spentTodayUsd: async (userId) => userId === one ? 1 : 9,
    drainUser: async (userId) => { drained.push(userId); return { attempted: 1, completed: 1 }; },
  }, { dailyBudgetUsd: 12, claimLimit: 5 }, new Date('2026-01-01T12:00:00Z'));
  assert.deepEqual(drained, [one]);
  assert.deepEqual(report, { users: 2, drained: 1, skippedOverBudget: 1, failures: 0 });
});

test('independent lanes publish their clocks and stop promptly while sleeping', async () => {
  let releaseDiscovery!: () => void;
  let releaseJudgment!: () => void;
  const discoverySleep = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  const judgmentSleep = new Promise<void>((resolve) => { releaseJudgment = resolve; });
  const ports: LoopPorts = {
    tick: async () => ({ ...emptyTick, successfulPlatforms: ['alpha'], failedPlatforms: ['beta'] }),
    normalize: async () => ({ vacancyIds: [], failed: 0, closed: 0, expired: 0, selected: 0, refreshed: 0, normalized: 0,
      selectionFailures: 0, maintenanceFailures: 0, bySource: {} }),
    matchVacancies: async () => ({ matched: 0, failures: 0 }),
    scoreDue: async () => ({ users: 0, drained: 0, skippedOverBudget: 0, failures: 0 }),
    deliver: async () => undefined,
  };
  const loop = createEngineLoop(ports, {
    discovery: { nextWakeMs: async () => 999_999, sleep: async () => discoverySleep },
    judgment: { nextWakeMs: async () => 888_888, sleep: async () => judgmentSleep },
  });
  const running = loop.run();
  while (loop.status().discovery.iterations === 0 || loop.status().judgment.iterations === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(loop.status().discovery.lastWakeMs, 999_999);
  assert.deepEqual(loop.status().discovery.lastSuccessfulPlatforms, ['alpha']);
  assert.deepEqual(loop.status().discovery.lastFailedPlatforms, ['beta']);
  assert.equal(loop.status().judgment.lastWakeMs, 888_888);
  loop.stop();
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop did not stop promptly')), 100)),
  ]);
  assert.equal(loop.status().running, false);
  releaseDiscovery();
  releaseJudgment();
});
