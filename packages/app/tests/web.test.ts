import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderedShutdown, createWebApp, startHttpServer, validWebhookSecret, webhookSecretMatches } from '../src/web.ts';

const secret = 'a'.repeat(32);
function fixture(overrides: Partial<Parameters<typeof createWebApp>[0]['ports']> = {}) {
  const events: string[] = [];
  const ports = { persistenceReady: async () => 'postgres' as const, engineReady: () => true,
    claimTelegramUpdate: async (id: number) => { events.push(`claim:${id}`); return true; },
    completeTelegramUpdate: async (id: number) => { events.push(`complete:${id}`); return true; },
    failTelegramUpdate: async (id: number) => { events.push(`fail:${id}`); return true; },
    handleTelegramUpdate: async (update: unknown) => { events.push(`handle:${(update as { update_id: number }).update_id}`); }, ...overrides };
  return { ports, events };
}

test('webhook secret validation is URL-safe, bounded, equal-length, and timing-safe compatible', () => {
  assert.equal(validWebhookSecret(secret), true); assert.equal(validWebhookSecret('a'.repeat(31)), false);
  assert.equal(validWebhookSecret('a'.repeat(257)), false); assert.equal(validWebhookSecret(`${'a'.repeat(31)}!`), false);
  assert.equal(webhookSecretMatches(secret, secret), true); assert.equal(webhookSecretMatches(secret, 'b'.repeat(32)), false);
  assert.equal(webhookSecretMatches(secret, 'a'.repeat(31)), false);
});

test('/health is detail-free and /ready requires postgres plus engine ownership', async () => {
  const good = fixture(); const app = createWebApp({ telegramMode: 'off', ports: good.ports });
  assert.deepEqual(await (await app.request('/health')).json(), { ok: true });
  assert.deepEqual(await (await app.request('/ready')).json(), { ok: true, persistence: 'postgres' });
  const waiting = fixture({ engineReady: () => false });
  const waitingApp = createWebApp({ telegramMode: 'off', ports: waiting.ports });
  assert.equal((await waitingApp.request('/health')).status, 200);
  assert.equal((await waitingApp.request('/ready')).status, 503);
  const bad = fixture({ persistenceReady: async () => { throw new Error('postgres://secret'); } });
  const response = await createWebApp({ telegramMode: 'off', ports: bad.ports }).request('/ready');
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false });
});

test('webhook route exists only in webhook mode and rejects bad secret before body/claim', async () => {
  const off = fixture(); assert.equal((await createWebApp({ telegramMode: 'polling', ports: off.ports }).request('/telegram/webhook', { method: 'POST' })).status, 404);
  const value = fixture(); const app = createWebApp({ telegramMode: 'webhook', webhookSecret: secret, ports: value.ports });
  const response = await app.request('/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': 'wrong' }, body: JSON.stringify({ update_id: 1 }) });
  assert.equal(response.status, 401); assert.deepEqual(value.events, []);
});

test('webhook validates body/update ID, claims before handling, completes success, and treats duplicate as success', async () => {
  const value = fixture(); const app = createWebApp({ telegramMode: 'webhook', webhookSecret: secret, ports: value.ports });
  const request = (body: string) => app.request('/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': secret }, body });
  assert.equal((await request('{bad')).status, 400); assert.equal((await request(JSON.stringify({ update_id: -1 }))).status, 400);
  const response = await request(JSON.stringify({ update_id: 7, message: { text: 'private payload' } }));
  assert.equal(response.status, 200); assert.deepEqual(value.events, ['claim:7', 'handle:7', 'complete:7']);

  const duplicate = fixture({ claimTelegramUpdate: async () => false });
  const duplicateResponse = await createWebApp({ telegramMode: 'webhook', webhookSecret: secret, ports: duplicate.ports })
    .request('/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ update_id: 8 }) });
  assert.deepEqual(await duplicateResponse.json(), { ok: true, duplicate: true }); assert.deepEqual(duplicate.events, []);
});

test('webhook bounds body and records failed claim without exposing error text', async () => {
  const value = fixture({ handleTelegramUpdate: async () => { throw new Error('token=TOP_SECRET'); } });
  const app = createWebApp({ telegramMode: 'webhook', webhookSecret: secret, maximumWebhookBytes: 30, ports: value.ports });
  const headers = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret };
  const large = await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify({ update_id: 1, payload: 'x'.repeat(100) }) });
  assert.equal(large.status, 413);
  const failed = await createWebApp({ telegramMode: 'webhook', webhookSecret: secret, ports: value.ports })
    .request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify({ update_id: 9 }) });
  assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { ok: false });
  assert.deepEqual(value.events.slice(-2), ['claim:9', 'fail:9']);
});

test('HTTP port validates and ordered shutdown continues through failures exactly once', async () => {
  const app = createWebApp({ telegramMode: 'off', ports: fixture().ports });
  assert.throws(() => startHttpServer(app, 0), /1 through 65535/u);
  const events: string[] = [];
  const shutdown = createOrderedShutdown({ stopEngine: async () => { events.push('engine'); }, stopTelegram: async () => { events.push('telegram'); throw new Error('stop'); },
    stopWorker: async () => { events.push('worker'); }, stopHttp: async () => { events.push('http'); }, closeApplication: async () => { events.push('app'); } });
  await assert.rejects(shutdown(), /stop/u); await assert.rejects(shutdown(), /stop/u);
  assert.deepEqual(events, ['engine', 'telegram', 'worker', 'http', 'app']);
});
