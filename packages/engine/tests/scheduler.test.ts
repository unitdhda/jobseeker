import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTransition, canTransition, nextCadence, pickDueUnits, type SchedulableUnit } from '../src/index.ts';

const policy = { floorMinutes: 30, ceilingMinutes: 720 };
const unit = (unitId: string, subscribers: string[], overdueMinutes: number): SchedulableUnit =>
  ({ unitId, platform: 'hh', subscribers, nextRunAt: -overdueMinutes * 60_000 });

test('cadence tightens on novelty, backs off on silence, and never leaves its bounds', () => {
  assert.equal(nextCadence(120, true, policy), 60);
  assert.equal(nextCadence(120, false, policy), 180);
  assert.equal(nextCadence(30, true, policy), 30, 'floor holds');
  assert.equal(nextCadence(720, false, policy), 720, 'ceiling holds');
  assert.equal(nextCadence(5, false, policy), 45, 'out-of-range input is clamped before stepping');
});

test('every subscriber of a due unit is served before breadth spends the budget', () => {
  // u1 owns the four most overdue units; the naive most-overdue-first order would spend the whole budget on u1.
  const units = [
    unit('a1', ['u1'], 500), unit('a2', ['u1'], 400), unit('a3', ['u1'], 300), unit('a4', ['u1'], 200),
    unit('b', ['u2'], 50), unit('c', ['u3'], 40), unit('d', ['u4'], 30), unit('e', ['u5'], 20),
  ];
  const picked = pickDueUnits(units, 5, 0);
  const served = new Set(picked.flatMap((entry) => entry.subscribers));
  assert.deepEqual([...served].sort(), ['u1', 'u2', 'u3', 'u4', 'u5']);
});

test('spare budget goes to the most overdue units', () => {
  const units = [unit('a', ['u1'], 500), unit('b', ['u1'], 400), unit('c', ['u2'], 300), unit('d', ['u2'], 10)];
  const picked = pickDueUnits(units, 3, 0).map((entry) => entry.unitId);
  assert.deepEqual(picked.sort(), ['a', 'b', 'c'], 'd is the least overdue and misses the cut');
});

test('a shared unit covers all its subscribers at once', () => {
  const units = [unit('shared', ['u1', 'u2'], 100), unit('own1', ['u1'], 90), unit('own2', ['u2'], 80),
    unit('own3', ['u3'], 70)];
  const picked = pickDueUnits(units, 2, 0);
  const served = new Set(picked.flatMap((entry) => entry.subscribers));
  assert.ok(served.has('u3'), 'u3 must not be crowded out');
  assert.deepEqual([...served].sort(), ['u1', 'u2', 'u3']);
});

test('units that are not due never run, whatever the budget', () => {
  const future = { unitId: 'f', platform: 'hh', subscribers: ['u1'], nextRunAt: 60_000 };
  assert.deepEqual(pickDueUnits([future], 10, 0), []);
});

test('the delivered wall: no path leads from a delivered state back to delivery', () => {
  for (const from of ['alerted', 'digested', 'skipped', 'applying', 'applied'] as const) {
    for (const to of ['alerted', 'digested'] as const) {
      if (from === 'applying') continue; // application failure returns to its origin state
      assert.equal(canTransition(from, to), false, `${from} -> ${to} must be illegal`);
    }
  }
  assert.throws(() => assertTransition('applied', 'alerted'));
  assert.doesNotThrow(() => assertTransition('scored', 'alerted'));
});
