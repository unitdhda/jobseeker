import assert from 'node:assert/strict';
import test from 'node:test';
import { nextCadence } from '../src/cadence.ts';
import {
  adaptiveConcurrency,
  aggregateOrderedProgress,
  KeyedTaskScheduler,
  mapConcurrent,
} from '../src/concurrency.ts';
import { parseSourceKey, parseUserId } from '../src/contracts.ts';
import { unitIdentityOf } from '../src/identity.ts';
import { deliveredStates } from '../src/match-state.ts';
import { pickDueUnits, type SchedulableUnit } from '../src/pick.ts';

test('cadence clamps before adapting and respects both bounds', () => {
  const policy = { floorMinutes: 15, ceilingMinutes: 240 };
  assert.equal(nextCadence(5, true, policy), 15);
  assert.equal(nextCadence(500, false, policy), 240);
  assert.equal(nextCadence(61, true, policy), 31);
  assert.equal(nextCadence(61, false, policy), 92);
});

test('fair selection maximizes subscriber coverage before overdue breadth', () => {
  const platform = parseSourceKey('example');
  const one = parseUserId('1');
  const two = parseUserId('2');
  const now = new Date('2026-01-01T12:00:00Z');
  const make = (text: string, subscribers: typeof one[], nextRunAt: string): SchedulableUnit => ({
    unitId: unitIdentityOf(platform, { text }).unitId,
    platform,
    subscribers,
    nextRunAt: new Date(nextRunAt),
  });
  const oldest = make('oldest', [one], '2026-01-01T09:00:00Z');
  const shared = make('shared', [one, two], '2026-01-01T10:00:00Z');
  const future = make('future', [two], '2026-01-01T13:00:00Z');

  assert.deepEqual(pickDueUnits([oldest, shared, future], 1, now), [shared]);
  assert.deepEqual(pickDueUnits([oldest, shared, future], 2, now), [oldest, shared]);
});

test('concurrency utilities bound work, preserve order, and serialize each key', async () => {
  assert.equal(adaptiveConcurrency(7, 2, 5), 3);
  const mapped = await mapConcurrent([20, 1, 10], 2, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return index;
  });
  assert.deepEqual(mapped, [0, 1, 2]);

  const scheduler = new KeyedTaskScheduler(2);
  const events: string[] = [];
  await Promise.all([
    scheduler.run('same', async () => { events.push('first:start'); await new Promise((resolve) => setTimeout(resolve, 5)); events.push('first:end'); }),
    scheduler.run('same', async () => { events.push('second:start'); }),
    scheduler.run('other', async () => { events.push('other:start'); }),
  ]);
  assert.ok(events.indexOf('first:end') < events.indexOf('second:start'));
  assert.ok(events.indexOf('other:start') < events.indexOf('first:end'));
});

test('ordered progress does not expose a later phase before every key reaches it', () => {
  const updates: Array<[string, number, number]> = [];
  const progress = aggregateOrderedProgress(['a', 'b'], ['fetch', 'parse'] as const,
    (phase, current, total) => updates.push([phase, current, total]));
  progress.report('a', 'fetch', 1, 2);
  assert.deepEqual(updates, []);
  progress.report('b', 'fetch', 1, 3);
  progress.report('a', 'parse', 0, 1);
  assert.equal(updates.at(-1)?.[0], 'fetch');
  progress.report('b', 'parse', 0, 1);
  assert.equal(updates.at(-1)?.[0], 'parse');
});

test('delivered-state wall includes every state that must not become fresh delivery again', () => {
  assert.deepEqual(deliveredStates, ['alerted', 'digested', 'skipped', 'applying', 'applied']);
});
