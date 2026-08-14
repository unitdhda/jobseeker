import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '@jobseeker/engine/contracts';
import type { MatchedVacancySearchResult, SessionClaim, TelegramUser } from '@jobseeker/store';
import type { WorkflowSessionPorts } from '../src/telegram/workflow-lock.ts';
import type { RoutedTelegramContext } from '../src/telegram/bot.ts';
import { createCommandHandlers, type CommandPorts } from '../src/telegram/commands.ts';
import { messages } from '../src/i18n/index.ts';

const userId = parseUserId('1');
const user: TelegramUser = { userId, username: null, firstName: 'Owner', lastName: null, status: 'approved', isOwner: true,
  locale: 'en', localeSelected: true, createdAt: new Date(), updatedAt: new Date() };
function context(command: RoutedTelegramContext['command'], argument = '', messageId?: number): RoutedTelegramContext {
  return { command, argument, user, locale: 'en', t: messages('en'), messageId };
}
function fixture() {
  const events: string[] = []; const replies: string[] = [];
  const inertSession: WorkflowSessionPorts = {
    getTelegramSession: async <TResult>() => null as TResult | null,
    claimTelegramSession: async <TResult extends Record<string, unknown>>(_user: typeof userId, _kind: string, state: TResult): Promise<SessionClaim<TResult>> =>
      ({ claimed: false, expiresAt: new Date(), state }),
    updateClaimedTelegramSession: async () => false,
    releaseClaimedTelegramSession: async () => false,
  };
  const ports: CommandPorts = {
    store: { getDeliverySettings: async () => null, saveDeliverySettings: async (_user, settings) => { events.push(`window:${settings.digestHourUtc}`); },
      exportUserData: async () => ({ user: 'export' }), getCvHash: async () => null,
      setUserStatus: async (id, status) => { events.push(`${status}:${id}`); return user; },
      listTelegramUsers: async () => ({ users: [user], total: 1 }), userUsageSummaries: async () => [],
      searchMatchedVacancies: async (id, query) => { events.push(`search:${id}:${query}`); return [{ id: 1, source: 'one', sourceId: '1', applyId: 'abcdef',
        status: 'normalized', url: new URL('https://example.test/job'), publishedAt: null, firstSeenAt: new Date(), lastSeenAt: new Date(),
        name: '<Backend>', employer: 'A & B', area: 'Remote', salary: null, experience: { kind: 'unspecified' }, employment: 'unspecified',
        schedule: 'unspecified', workFormat: 'remote', description: 'body', keySkills: [], sourceQuery: 'query', contentHash: 'a'.repeat(64),
        score: null, matchedAt: new Date() } as unknown as MatchedVacancySearchResult]; },
      llmUsageSummary: async () => ({ turns24h: 0, turnsTotal: 0, tokens24h: 0, tokensTotal: 0, cost24h: 0, costTotal: 0,
        hours: Array.from({ length: 25 }, (_, index) => ({ at: new Date(index * 3_600_000), tokens: 0, costUsd: 0 })) }),
      scraperSummary: async () => ({ hours: Array.from({ length: 25 }, (_, index) => ({ at: new Date(index * 3_600_000), normalized: 0, scored: 0 })),
        sources: [], units: [], matched24h: 0, scored24h: 0, parserErrors: [] }) },
    cvActions: { ...inertSession, setTelegramSession: async () => { events.push('arm'); }, deleteTelegramSession: async () => undefined,
      stageCvSource: async () => undefined, discardStagedCvSource: async () => undefined, confirmStagedCvSource: async () => false,
      getCvHash: async () => null },
    applicationActions: { ...inertSession, saveDeliveredArtifact: async () => true, markApplicationDelivered: async () => true },
    worker: { request: async () => { throw new Error('unused'); } },
    applicationTransport: { sendDocument: async () => ({ fileId: 'x' }), sendFileId: async () => undefined, sendText: async () => undefined },
    delivery: { isApprovedUser: async () => true, unsentHighScoreVacancies: async () => [], markAlerted: async () => true,
      digestVacancies: async () => [], addressableDigestPage: async () => ({ vacancies: [], allApplyIds: [], total: 0 }), replaceDigestSnapshot: async () => undefined },
    transport: { reply: async (_user, html) => { replies.push(html); }, sendDocument: async (_user, bytes) => { events.push(`export:${bytes.byteLength}`); },
      confirmDelete: async () => { events.push('confirm-delete'); } }, configuredSources: ['one'], digestMinScore: 50, alertScore: 80,
    defaultTimezone: 'UTC', runtimeStatus: () => ({ uptimeMs: 1000, rssBytes: 1, heapBytes: 1, cpuPercent: 0,
      workerPending: 0, aiActive: 0, aiQueued: 0, telegramMode: 'polling', engineRunning: true, discoveryStatus: 'running', judgmentStatus: 'running' }),
  };
  return { ports, events, replies };
}

test('owner approval/revocation validate canonical IDs before repository mutation', async () => {
  const value = fixture(); const handlers = createCommandHandlers(value.ports);
  await handlers.owner!.ok!(context('ok', 'bad')); assert.deepEqual(value.events, []); assert.match(value.replies.at(-1)!, /Usage/u);
  await handlers.owner!.ok!(context('ok', '2')); await handlers.owner!.revoke!(context('revoke', '3'));
  assert.deepEqual(value.events, ['approved:2', 'revoked:3']);
});

test('approved window, export, deletion confirmation, digest, and CV commands invoke intended ports', async () => {
  const value = fixture(); const handlers = createCommandHandlers(value.ports);
  await handlers.approved!.window!(context('window', '8')); await handlers.approved!.export_me!(context('export_me'));
  await handlers.approved!.delete_me!(context('delete_me')); await handlers.approved!.digest!(context('digest'));
  await handlers.approved!.cv!(context('cv'));
  assert.deepEqual(value.events.slice(0, 3), ['window:8', value.events[1], 'confirm-delete']); assert.match(value.events[1]!, /^export:/u);
  assert.equal(value.events.includes('arm'), true); assert.match(value.replies.join('\n'), /no matching vacancies/iu);
});

test('search queries the invoking user’s full match history and renders unscored results safely', async () => {
  const value = fixture(); const handlers = createCommandHandlers(value.ports);
  await handlers.approved!.search!(context('search', 'backend api'));
  assert.equal(value.events.includes('search:1:backend api'), true);
  assert.match(value.replies.at(-1)!, /—\/100/u); assert.match(value.replies.at(-1)!, /&lt;Backend&gt;/u);
  assert.match(value.replies.at(-1)!, /A &amp; B/u);
});

test('owner command sessions track the incoming command and every answer', async () => {
  const value = fixture(); const tracked: string[] = [];
  const handlers = createCommandHandlers({ ...value.ports,
    ownerMessageHistory: { begin: async (id, messageId) => { tracked.push(`begin:${id}:${messageId}`); return 7; },
      record: (id, generation, messageId) => { tracked.push(`record:${id}:${generation}:${messageId}`); } },
    transport: { ...value.ports.transport, reply: async (_user, html) => { value.replies.push(html); return 101; } },
  });
  await handlers.owner!.status!(context('status', '', 100));
  assert.deepEqual(tracked, ['begin:1:100', 'record:1:7:101']);
});

test('owner usage, scraper, users, and status produce escaped bounded output', async () => {
  const value = fixture(); const handlers = createCommandHandlers(value.ports);
  await handlers.owner!.usage!(context('usage')); await handlers.owner!.scraper!(context('scraper'));
  await handlers.owner!.users!(context('users')); await handlers.owner!.status!(context('status'));
  assert.ok(value.replies.length >= 4); assert.match(value.replies.join('\n'), /Usage — 24 hours/u);
  assert.match(value.replies.join('\n'), /Scraper and parser/u); assert.match(value.replies.join('\n'), /<code>1<\/code>/u);
  assert.match(value.replies.join('\n'), /CV: no/u); assert.match(value.replies.join('\n'), /Delivery: default/u);
});
