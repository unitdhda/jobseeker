import assert from 'node:assert/strict';
import test from 'node:test';
import { claimTelegramSession, deleteTelegramSession, getTelegramSession, setTelegramSession } from '../src/lib/telegram-sessions.ts';

test('local Telegram sessions persist state and enforce atomic cooldown claims', async () => {
  const userId = 'session-test-local';
  await setTelegramSession(userId, 'window-setup', { step: 'end', start: '09:00' }, 60_000);
  assert.deepEqual(await getTelegramSession(userId, 'window-setup'), { step: 'end', start: '09:00' });
  const first = await claimTelegramSession(userId, 'cv-cooldown', {}, 60_000);
  const second = await claimTelegramSession(userId, 'cv-cooldown', {}, 60_000);
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  await deleteTelegramSession(userId, 'window-setup');
  await deleteTelegramSession(userId, 'cv-cooldown');
  assert.equal(await getTelegramSession(userId, 'window-setup'), null);
});
