import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot, Context } from 'grammy';
import { parseUserId } from '@jobseeker/engine/contracts';
import type { TelegramIdentity, TelegramUser } from '@jobseeker/store';
import { installTelegramRoutes, type TelegramAccessPorts } from '../src/telegram/bot.ts';

const userId = parseUserId('123');
const approved: TelegramUser = { userId, username: null, firstName: 'Ada', lastName: null, status: 'approved', isOwner: false,
  locale: 'en', localeSelected: true, createdAt: new Date(), updatedAt: new Date() };
function botFixture() {
  let message: ((context: Context) => Promise<void>) | undefined;
  const bot = { on(event: string, handler: (context: Context) => Promise<void>) { if (event === 'message') message = handler; } } as unknown as Bot;
  return { bot, message: () => { if (!message) throw new Error('message handler not installed'); return message; } };
}
function portsFixture(existing: TelegramUser | null) {
  const calls = { get: 0, touch: 0, request: 0 };
  const ports: TelegramAccessPorts = {
    getTelegramUser: async () => { calls.get += 1; return existing; },
    touchTelegramUser: async (_identity: TelegramIdentity) => { calls.touch += 1; return existing ?? approved; },
    requestAccess: async () => { calls.request += 1; return { user: approved, notifyOwner: true, retryAfterSeconds: 0 }; },
    setUserLocale: async () => existing,
  };
  return { ports, calls };
}
function context(input: { text?: string; document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number } }) {
  const replies: string[] = [];
  return { value: { chat: { type: 'private' }, from: { id: 123, is_bot: false, first_name: 'Ada', language_code: 'en' },
    message: input, reply: async (text: string) => { replies.push(text); } } as unknown as Context, replies };
}

test('installed document route ignores unknown users and sends approved metadata without downloading', async () => {
  const unknown = portsFixture(null); const unknownBot = botFixture(); let documents = 0;
  installTelegramRoutes(unknownBot.bot, unknown.ports, 'ru', { document: async () => { documents += 1; } });
  await unknownBot.message()(context({ document: { file_id: 'file', file_name: 'cv.pdf', mime_type: 'application/pdf', file_size: 20 } }).value);
  assert.deepEqual(unknown.calls, { get: 1, touch: 0, request: 0 }); assert.equal(documents, 0);

  const known = portsFixture(approved); const knownBot = botFixture(); const values: unknown[] = [];
  installTelegramRoutes(knownBot.bot, known.ports, 'ru', { document: async (value) => { values.push(value); } });
  await knownBot.message()(context({ document: { file_id: 'file', file_name: 'cv.pdf', mime_type: 'application/pdf', file_size: 20 } }).value);
  assert.deepEqual(known.calls, { get: 1, touch: 1, request: 0 });
  assert.deepEqual(values.map((value) => { const item = value as { user: TelegramUser; locale: string; fileId: string; filename: string; mediaType?: string; declaredSize: number };
    return { userId: item.user.userId, locale: item.locale, fileId: item.fileId, filename: item.filename, mediaType: item.mediaType, declaredSize: item.declaredSize }; }),
  [{ userId, locale: 'en', fileId: 'file', filename: 'cv.pdf', mediaType: 'application/pdf', declaredSize: 20 }]);
});

test('installed approved text route invokes only the non-command text handler', async () => {
  const fixture = portsFixture(approved); const bot = botFixture(); const texts: string[] = [];
  installTelegramRoutes(bot.bot, fixture.ports, 'en', { handlers: { text: (value) => { texts.push(value.text); } } });
  await bot.message()(context({ text: '  BQE  ' }).value);
  assert.deepEqual(texts, ['  BQE  ']); assert.deepEqual(fixture.calls, { get: 1, touch: 1, request: 0 });

  await bot.message()(context({}).value);
  assert.deepEqual(texts, ['  BQE  ']);
});

test('installed /request route propagates owner notification', async () => {
  const fixture = portsFixture(null); const bot = botFixture(); const notifications: string[] = [];
  installTelegramRoutes(bot.bot, fixture.ports, 'en', { notifyOwner: async (text) => { notifications.push(text); } });
  const update = context({ text: '/request' }); await bot.message()(update.value);
  assert.equal(fixture.calls.request, 1); assert.deepEqual(notifications, ['Access request: 123']); assert.equal(update.replies.length, 1);
});
