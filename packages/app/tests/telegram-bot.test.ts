import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '@jobseeker/engine/contracts';
import type { Locale, TelegramIdentity, TelegramUser } from '@jobseeker/store';
import { approvedCommands, ownerCommands, publicCommands, routeTelegramUpdate, userCommands,
  type TelegramAccessPorts, type TelegramResponsePort } from '../src/telegram/bot.ts';

const userId = parseUserId('123');
const user = (overrides: Partial<TelegramUser> = {}): TelegramUser => ({ userId, username: null, firstName: 'Ada', lastName: null,
  status: 'approved', isOwner: false, locale: null, localeSelected: false, createdAt: new Date(), updatedAt: new Date(), ...overrides });
function fixture(existing: TelegramUser | null) {
  const calls = { get: 0, touch: 0, request: 0, locale: 0, replies: [] as string[], menus: [] as Array<{ locale: Locale; commands: readonly string[] }>,
    approved: 0, owner: 0, text: [] as string[], notified: 0 };
  let stored = existing;
  const ports: TelegramAccessPorts = {
    getTelegramUser: async () => { calls.get += 1; return stored; },
    touchTelegramUser: async (identity: TelegramIdentity) => { calls.touch += 1; stored ??= user({ status: 'unregistered', locale: identity.locale ?? null }); return stored; },
    requestAccess: async () => { calls.request += 1; stored ??= user({ status: 'pending' }); return { user: stored, notifyOwner: true, retryAfterSeconds: 0 }; },
    setUserLocale: async (_id, locale) => { calls.locale += 1; stored = stored ? { ...stored, locale, localeSelected: true } : null; return stored; },
  };
  const response: TelegramResponsePort = { reply: async (text) => { calls.replies.push(text); },
    notifyOwner: async () => { calls.notified += 1; }, setCommands: async (locale, commands) => { calls.menus.push({ locale, commands }); } };
  const handlers = { approved: Object.fromEntries(approvedCommands.map((command) => [command, () => { calls.approved += 1; }])),
    owner: Object.fromEntries(ownerCommands.map((command) => [command, () => { calls.owner += 1; }])),
    text: (context: { text: string }) => { calls.text.push(context.text); } };
  return { ports, response, handlers, calls };
}
const update = (text: string, languageCode = 'en-US', chatType = 'private') => ({ chatType, text,
  from: { id: 123, firstName: 'Ada', languageCode } });

test('command inventories contain exactly the required public, approved, and owner commands', () => {
  assert.deepEqual(publicCommands, ['start', 'request', 'language']);
  assert.deepEqual(approvedCommands, ['cv', 'window', 'digest', 'search', 'privacy', 'export_me', 'delete_me']);
  assert.deepEqual(ownerCommands, ['ok', 'users', 'revoke', 'usage', 'scraper', 'status']);
  assert.deepEqual(userCommands, [...publicCommands, ...approvedCommands]);
});

test('unknown arbitrary senders and non-private chats create no rows and invoke no command handlers', async () => {
  const unknown = fixture(null);
  assert.equal(await routeTelegramUpdate(update('hello'), unknown.ports, unknown.response, 'ru', unknown.handlers), null);
  assert.deepEqual(unknown.calls, { get: 1, touch: 0, request: 0, locale: 0, replies: [], menus: [], approved: 0, owner: 0, text: [], notified: 0 });
  const group = fixture(null);
  await routeTelegramUpdate(update('/start', 'en', 'group'), group.ports, group.response, 'ru', group.handlers);
  assert.equal(group.calls.get, 0); assert.equal(group.calls.touch, 0); assert.equal(group.calls.replies.length, 1);
});

test('/start, /request, and /language remain public while touching only their intended identity path', async () => {
  const start = fixture(null); const started = await routeTelegramUpdate(update('/start'), start.ports, start.response, 'ru', start.handlers);
  assert.equal(start.calls.touch, 1); assert.equal(start.calls.request, 0); assert.equal(started?.locale, 'en');

  const request = fixture(null); await routeTelegramUpdate(update('/request'), request.ports, request.response, 'ru', request.handlers);
  assert.equal(request.calls.touch, 0); assert.equal(request.calls.request, 1); assert.equal(request.calls.notified, 1);

  const language = fixture(null); const changed = await routeTelegramUpdate(update('/language', 'ru-RU'), language.ports, language.response, 'ru', language.handlers);
  assert.equal(language.calls.touch, 1); assert.equal(language.calls.locale, 1); assert.equal(changed?.locale, 'en');
  assert.deepEqual(language.calls.menus[0]?.commands, publicCommands);
});

test('approved middleware resolves locale and touches identity exactly once before handler', async () => {
  const value = fixture(user({ locale: 'ru', localeSelected: true }));
  const context = await routeTelegramUpdate(update('/digest', 'en-US'), value.ports, value.response, 'en', value.handlers);
  assert.equal(context?.locale, 'ru'); assert.equal(value.calls.get, 1); assert.equal(value.calls.touch, 1);
  assert.equal(value.calls.approved, 1); assert.equal(value.calls.owner, 0);
});

test('approved non-command text routes once while non-text and unapproved text retain existing behavior', async () => {
  const approved = fixture(user({ locale: 'ru', localeSelected: true }));
  const context = await routeTelegramUpdate(update('  BQE  '), approved.ports, approved.response, 'en', approved.handlers);
  assert.equal(context?.locale, 'ru'); assert.deepEqual(approved.calls.text, ['  BQE  ']); assert.equal(approved.calls.touch, 1);

  assert.equal(await routeTelegramUpdate({ ...update('ignored'), text: undefined }, approved.ports, approved.response, 'en', approved.handlers), null);
  assert.deepEqual(approved.calls.text, ['  BQE  ']);
  const pending = fixture(user({ status: 'pending' }));
  assert.equal(await routeTelegramUpdate(update('abcdef'), pending.ports, pending.response, 'en', pending.handlers), null);
  assert.deepEqual(pending.calls.text, []); assert.equal(pending.calls.touch, 0); assert.deepEqual(pending.calls.replies, []);
});

test('owner commands are hidden and rejected before touching a non-owner identity', async () => {
  const denied = fixture(user({ isOwner: false }));
  assert.equal(await routeTelegramUpdate(update('/status'), denied.ports, denied.response, 'en', denied.handlers), null);
  assert.equal(denied.calls.owner, 0); assert.equal(denied.calls.touch, 0); assert.equal(denied.calls.replies.length, 1);

  const owner = fixture(user({ isOwner: true, locale: 'ru', localeSelected: true }));
  await routeTelegramUpdate(update('/status'), owner.ports, owner.response, 'en', owner.handlers);
  assert.equal(owner.calls.owner, 1); assert.equal(owner.calls.touch, 1);
  await routeTelegramUpdate(update('/language'), owner.ports, owner.response, 'en', owner.handlers);
  assert.deepEqual(owner.calls.menus.at(-1)?.commands, userCommands);
});

test('known but unapproved user gets explicit denial without identity touch', async () => {
  const pending = fixture(user({ status: 'pending' }));
  assert.equal(await routeTelegramUpdate(update('/cv'), pending.ports, pending.response, 'en', pending.handlers), null);
  assert.equal(pending.calls.touch, 0); assert.equal(pending.calls.approved, 0); assert.equal(pending.calls.replies.length, 1);
});
