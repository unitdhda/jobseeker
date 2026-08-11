import test from 'node:test';
import assert from 'node:assert/strict';
import { admitPrescore } from '../src/matching.ts';
import { explorePrescore } from '../src/workflows.ts';

test('semantic prescore admits passes and a frozen exploration sample only', () => {
  assert.equal(admitPrescore(50, false, 50), true);
  assert.equal(admitPrescore(49, true, 50), true);
  assert.equal(admitPrescore(49, false, 50), false);
  assert.equal(admitPrescore(null, true, 50), false);
});

test('prescore exploration is sampled only below the production threshold', () => {
  assert.equal(explorePrescore(39, () => 0.09), true);
  assert.equal(explorePrescore(39, () => 0.1), false);
  let called = false;
  assert.equal(explorePrescore(40, () => { called = true; return 0; }), false);
  assert.equal(called, false);
});
