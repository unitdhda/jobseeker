import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceKey, parseSourceVacancyId, parseUserId } from '@jobseeker/engine/contracts';
import type { ScoredVacancy, TelegramUser } from '@jobseeker/store';
import { retrieveMatchByCode, type MatchCodePorts } from '../src/telegram/match-code.ts';

const userId = parseUserId('1');
const user: TelegramUser = { userId, username: null, firstName: 'Ada', lastName: null, status: 'approved', isOwner: false,
  locale: 'en', localeSelected: true, createdAt: new Date(), updatedAt: new Date() };
function vacancy(id: number, applyId: string): ScoredVacancy {
  return { id, applyId, lifecycleStatus: 'normalized', userId, score: 87, source: parseSourceKey('test'),
    sourceId: parseSourceVacancyId(String(id)), name: '<Backend & API>', employer: 'A <Corp>', area: 'Remote', salary: null,
    experience: { kind: 'unspecified' }, employment: 'full-time', schedule: 'standard', workFormat: 'remote', description: 'body',
    keySkills: [], url: new URL(`https://example.test/${id}`), publishedAt: new Date(), sourceQuery: 'private', primaryTrack: null,
    summary: null, reasons: [], gaps: [], explanation: null };
}
function fixture(matches: readonly ScoredVacancy[], scoredApplyIds: readonly string[] = matches.map((item) => item.applyId)) {
  const replies: Array<{ html: string; buttons?: readonly { text: string; url?: string; callbackData?: string }[] }> = [];
  let lookups = 0; let snapshots = 0;
  const ports: MatchCodePorts = { store: {
    scoredVacanciesByApplyIdPrefix: async () => { lookups += 1; return matches; },
    scoredVacancyApplyIds: async () => { snapshots += 1; return scoredApplyIds; },
  }, transport: { reply: async (_user, html, buttons) => { replies.push({ html, buttons }); } } };
  return { ports, replies, lookups: () => lookups, snapshots: () => snapshots };
}

test('invalid and unmatched codes share localized not-found behavior without leaking or unnecessary reads', async () => {
  const invalid = fixture([]);
  assert.equal(await retrieveMatchByCode({ text: 'not a code', user, locale: 'en' }, invalid.ports), 'not-found');
  assert.equal(invalid.lookups(), 0); assert.equal(invalid.snapshots(), 0);
  assert.deepEqual(invalid.replies, [{ html: 'No vacancy was found for that code.', buttons: undefined }]);

  const unmatched = fixture([]);
  assert.equal(await retrieveMatchByCode({ text: '  BQE  ', user, locale: 'ru' }, unmatched.ports), 'not-found');
  assert.equal(unmatched.lookups(), 1); assert.match(unmatched.replies[0]!.html, /не найдена/u);
});

test('ambiguous prefix asks for more letters without disclosing codes or counts', async () => {
  const value = fixture([vacancy(1, 'bqerit'), vacancy(2, 'bqexyz')]);
  assert.equal(await retrieveMatchByCode({ text: 'bqe', user, locale: 'en' }, value.ports), 'ambiguous');
  assert.equal(value.snapshots(), 0); assert.match(value.replies[0]!.html, /more letters/u);
  assert.doesNotMatch(value.replies[0]!.html, /bqerit|bqexyz|2/u); assert.equal(value.replies[0]!.buttons, undefined);
});

test('unique code renders escaped full code and exactly Open, Letter, CV actions', async () => {
  const value = fixture([vacancy(7, 'bqerit')], ['bqerit', 'bqexyz']);
  assert.equal(await retrieveMatchByCode({ text: 'BQER', user, locale: 'en' }, value.ports), 'matched');
  const reply = value.replies[0]!;
  assert.match(reply.html, /<b>bqer<\/b>it/u); assert.match(reply.html, /&lt;Backend &amp; API&gt;/u);
  assert.match(reply.html, /A &lt;Corp&gt;/u); assert.equal(reply.html.includes('<Backend'), false);
  assert.deepEqual(reply.buttons, [
    { text: 'Open', url: 'https://example.test/7' },
    { text: 'Letter', callbackData: 'apply:letter:7' },
    { text: 'CV', callbackData: 'apply:cv:7' },
  ]);

  const russian = fixture([vacancy(7, 'bqerit')]);
  await retrieveMatchByCode({ text: 'bqerit', user: { ...user, locale: 'ru' }, locale: 'ru' }, russian.ports);
  assert.deepEqual(russian.replies[0]!.buttons?.map((button) => button.text), ['Открыть', 'Письмо', 'CV']);
  assert.match(russian.replies[0]!.html, /Оценка/u);
});
