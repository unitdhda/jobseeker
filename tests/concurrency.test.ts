import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptiveConcurrency, AdaptiveTaskPool, mapConcurrent } from '../src/lib/adaptive-concurrency.ts';

test('LLM scoring concurrency scales from five to ten with queued load', () => {
  assert.equal(adaptiveConcurrency(0, 5, 10), 0);
  assert.equal(adaptiveConcurrency(3, 5, 10), 3);
  assert.equal(adaptiveConcurrency(5, 5, 10), 5);
  assert.equal(adaptiveConcurrency(10, 5, 10), 6);
  assert.equal(adaptiveConcurrency(20, 5, 10), 8);
  assert.equal(adaptiveConcurrency(30, 5, 10), 10);
  assert.equal(adaptiveConcurrency(100, 5, 10), 10);
});

test('adaptive task pool never exceeds its load-derived maximum', async () => {
  const pool = new AdaptiveTaskPool(5, 10);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observed = 0;
  const tasks = Array.from({ length: 30 }, () => pool.run(async () => {
    observed = Math.max(observed, pool.activeCount);
    await gate;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.activeCount, 10);
  assert.equal(pool.queuedCount, 20);
  release();
  await Promise.all(tasks);
  assert.equal(observed, 10);
  assert.equal(pool.activeCount, 0);
});

test('concurrent mapping preserves result order and its bound', async () => {
  let active = 0; let maximum = 0;
  const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(maximum, 3);
});
