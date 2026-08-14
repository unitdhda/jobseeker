import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '@jobseeker/engine/contracts';
import { startTelegramOwnership, type TelegramReceiverBot } from '../src/telegram/ownership.ts';

function bot() {
  const events: string[] = []; let release!: () => void;
  const polling = new Promise<void>((resolve) => { release = resolve; });
  const value: TelegramReceiverBot = { init: async () => { events.push('init'); }, start: async () => { events.push('start'); await polling; },
    stop: async () => { events.push('stop'); release(); }, handleUpdate: async () => { events.push('update'); },
    setWebhook: async (url, secret) => { events.push(`webhook:${url}:${secret.length}`); }, deleteWebhook: async () => { events.push('delete-webhook'); },
    deleteCommands: async (scope, locale) => { events.push(`delete:${scope}:${locale ?? '*'}`); },
    deleteUserCommands: async (userId, locale) => { events.push(`delete-user:${userId}:${locale ?? '*'}`); },
    setUserCommands: async (userId, locale, commands) => { events.push(`user-commands:${userId}:${locale ?? '*'}:${commands.join(',')}`); } };
  return { value, events };
}

test('off mode initializes no receiver or command menu', async () => {
  const value = bot(); const ownership = await startTelegramOwnership({ mode: 'off', bot: value.value });
  assert.deepEqual(value.events, []); assert.equal(ownership.polling, false); assert.equal(await ownership.handleWebhook({}, undefined), false);
  await ownership.stop(); assert.deepEqual(value.events, []);
});

test('polling clears global and stale owner menus without registering commands', async () => {
  const value = bot(); const ownerUserId = parseUserId('123');
  const ownership = await startTelegramOwnership({ mode: 'polling', bot: value.value, ownerUserId });
  assert.deepEqual(value.events, ['init',
    'delete:default:*', 'delete:all_private_chats:*', 'delete-user:123:*',
    'delete:default:ru', 'delete:all_private_chats:ru', 'delete-user:123:ru',
    'delete:default:en', 'delete:all_private_chats:en', 'delete-user:123:en',
    'delete-webhook', 'start']);
  assert.equal(ownership.polling, true); assert.equal(await ownership.handleWebhook({}, undefined), false);
  assert.equal(value.events.includes('update'), false); await ownership.stop(); await ownership.stop();
  assert.deepEqual(value.events.slice(-1), ['stop']);
});

test('webhook mode never polls and requires exact secret for one update handler', async () => {
  const value = bot(); const secret = 's'.repeat(32);
  const ownership = await startTelegramOwnership({ mode: 'webhook', bot: value.value,
    webhookUrl: 'https://bot.example.test/telegram/webhook', webhookSecret: secret });
  assert.deepEqual(value.events, ['init',
    'delete:default:*', 'delete:all_private_chats:*',
    'delete:default:ru', 'delete:all_private_chats:ru',
    'delete:default:en', 'delete:all_private_chats:en',
    'webhook:https://bot.example.test/telegram/webhook:32']); assert.equal(ownership.polling, false);
  assert.equal(await ownership.handleWebhook({}, 'wrong'), false); assert.equal(await ownership.handleWebhook({}, secret), true);
  assert.deepEqual(value.events.slice(-1), ['update']); await ownership.stop(); assert.equal(value.events.includes('stop'), false);
  assert.equal(await ownership.handleWebhook({}, secret), false);
  await assert.rejects(startTelegramOwnership({ mode: 'webhook', bot: bot().value,
    webhookUrl: 'http://unsafe.example.test/telegram/webhook', webhookSecret: 'short' }), /HTTPS URL/u);
});
