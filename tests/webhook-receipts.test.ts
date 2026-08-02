import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimTelegramUpdate, claimTelegramUserUpdateLease, completeTelegramUpdate, failTelegramUpdate,
  releaseTelegramUserUpdateLease, telegramUpdateUserId,
} from '../src/lib/telegram-webhook-receipts.ts';

test('local Telegram update receipts deduplicate completed work and retry failures', async () => {
  const completedId = 9_000_001;
  assert.equal(await claimTelegramUpdate(completedId), true);
  assert.equal(await claimTelegramUpdate(completedId), false);
  await completeTelegramUpdate(completedId);
  assert.equal(await claimTelegramUpdate(completedId), false);

  const failedId = 9_000_002;
  assert.equal(await claimTelegramUpdate(failedId), true);
  await failTelegramUpdate(failedId, new Error('expected'));
  assert.equal(await claimTelegramUpdate(failedId), true);

  assert.equal(telegramUpdateUserId({ message: { from: { id: 42 } } }), '42');
  assert.equal(telegramUpdateUserId({ callback_query: { from: { id: 43 } } }), '43');
  assert.equal(await claimTelegramUserUpdateLease('42', completedId), true);
  assert.equal(await claimTelegramUserUpdateLease('42', failedId), false);
  await releaseTelegramUserUpdateLease('42', completedId);
  assert.equal(await claimTelegramUserUpdateLease('42', failedId), true);
  await releaseTelegramUserUpdateLease('42', failedId);
});
