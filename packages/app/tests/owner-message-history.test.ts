import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '@jobseeker/engine/contracts';
import { createOwnerMessageHistory } from '../src/telegram/owner-message-history.ts';

const userId = parseUserId('123');

test('a new owner command deletes the previous command and every recorded answer', async () => {
  const deleted: number[] = [];
  const history = createOwnerMessageHistory(async (_userId, messageId) => { deleted.push(messageId); });
  const first = await history.begin(userId, 10);
  history.record(userId, first, 11); history.record(userId, first, 12);
  const second = await history.begin(userId, 20);
  assert.deepEqual(deleted, [10, 11, 12]);
  history.record(userId, second, 21);
  await history.begin(userId, 30);
  assert.deepEqual(deleted, [10, 11, 12, 20, 21]);
});

test('stale replies cannot enter a newer owner command session and deletion failures are best effort', async () => {
  const deleted: number[] = [];
  const history = createOwnerMessageHistory(async (_userId, messageId) => {
    deleted.push(messageId); if (messageId === 40) throw new Error('already deleted');
  });
  const stale = await history.begin(userId, 40);
  const current = await history.begin(userId, 50);
  history.record(userId, stale, 41); history.record(userId, current, 51);
  await history.begin(userId, 60);
  assert.deepEqual(deleted, [40, 50, 51]);
});
