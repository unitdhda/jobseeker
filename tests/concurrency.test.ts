import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptiveConcurrency, AdaptiveTaskPool, KeyedTaskScheduler, mapConcurrent } from '../src/concurrency.ts';

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

test('keyed scheduler overlaps users but serializes each user', async () => {
  const scheduler = new KeyedTaskScheduler(2);
  const events: string[] = [];
  let releaseFirst!: () => void;
  let releaseOther!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
  const first = scheduler.run('user-a', async () => { events.push('a1:start'); await firstGate; events.push('a1:end'); });
  const second = scheduler.run('user-a', async () => { events.push('a2:start'); });
  const other = scheduler.run('user-b', async () => { events.push('b:start'); await otherGate; events.push('b:end'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.activeCount, 2);
  assert.deepEqual(events, ['a1:start', 'b:start']);
  releaseFirst();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.indexOf('a2:start') > events.indexOf('a1:end'));
  releaseOther();
  await Promise.all([second, other]);
  assert.equal(scheduler.activeCount, 0);
});

test('a failed keyed task does not block later work for that user', async () => {
  const scheduler = new KeyedTaskScheduler(2);
  const failed = scheduler.run('user', async () => { throw new Error('expected'); });
  const next = scheduler.run('user', async () => 42);
  await assert.rejects(failed, /expected/);
  assert.equal(await next, 42);
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
