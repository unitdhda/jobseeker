import assert from 'node:assert/strict';
import test from 'node:test';
import { nextFairScoreRound } from '../src/lib/fairness.ts';

test('500-score global budget gives 50 users ten fair slots each', () => {
  const users = Array.from({ length: 50 }, (_, index) => ({ userId: String(index + 1), used: 0 }));
  const round = nextFairScoreRound(users, 500, 50);
  assert.equal(round.length, 50);
  assert.equal(round.reduce((sum, item) => sum + item.limit, 0), 500);
  assert.ok(round.every((item) => item.limit === 10));
});

test('daily limits and remaining global budget are respected', () => {
  const round = nextFairScoreRound([
    { userId: 'a', used: 50 }, { userId: 'b', used: 48 }, { userId: 'c', used: 0 },
  ], 7, 50);
  assert.deepEqual(round, [{ userId: 'b', limit: 2 }, { userId: 'c', limit: 5 }]);
});
