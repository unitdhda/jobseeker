import assert from 'node:assert/strict';
import test from 'node:test';
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate } from '../src/lib/telegram-webhook-receipts.ts';

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

});
