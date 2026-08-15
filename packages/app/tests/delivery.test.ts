import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceKey, parseSourceVacancyId, parseUserId } from '@jobseeker/engine/contracts';
import type { AlertVacancy, ScoredVacancy } from '@jobseeker/store';
import { onDemandDigest, sendHighAlerts, sendScheduledDigest, type DeliveryPorts } from '../src/telegram/delivery.ts';

const userId = parseUserId('1'); const source = parseSourceKey('test');
function vacancy(id: number, applyId: string, score = 70): ScoredVacancy {
  return { id, applyId, lifecycleStatus: 'normalized', userId, score, source, sourceId: parseSourceVacancyId(String(id)),
    name: `Vacancy ${id}`, employer: 'Acme', area: 'Remote', salary: null, experience: { kind: 'unspecified' },
    employment: 'full-time', schedule: 'standard', workFormat: 'remote', description: 'x', keySkills: [],
    url: new URL(`https://example.test/${id}`), publishedAt: new Date(), sourceQuery: 'private', primaryTrack: 'Track',
    summary: 'Summary', reasons: ['Reason'], gaps: [], explanation: null };
}
function ports(vacancies: readonly ScoredVacancy[], scoredApplyIds = vacancies.map((item) => item.applyId)) {
  const marked: number[] = []; const snapshots: number[][] = [];
  const value: DeliveryPorts = { isApprovedUser: async () => true,
    unsentHighScoreVacancies: async () => vacancies as readonly AlertVacancy[], markAlerted: async (_user, id) => { marked.push(id); return true; },
    digestVacancies: async () => vacancies,
    addressableDigestPage: async (_user, _minimum, _high, size, page) => ({ vacancies: vacancies.slice(page * size, (page + 1) * size),
      allApplyIds: vacancies.map((item) => item.applyId), total: vacancies.length }),
    replaceDigestSnapshot: async (_user, ids) => { snapshots.push([...ids]); },
    scoredVacancyApplyIds: async () => scoredApplyIds };
  return { value, marked, snapshots };
}

test('high alerts send sequentially, mark only after send, pace, and defer remaining queue on 429', async () => {
  const fixture = ports([vacancy(1, 'abcdef', 90), vacancy(2, 'abcxyz', 85), vacancy(3, 'zbcdef', 82)]);
  const sent: number[] = []; const sleeps: number[] = [];
  const result = await sendHighAlerts({ userId, locale: 'en', minimumScore: 80, ports: fixture.value,
    transport: { sendAlert: async (_user, _html, item) => { if (item.id === 2) throw { kind: 'rate-limit', retryAfterSeconds: 5, message: 'rate' }; sent.push(item.id); },
      sendDigest: async () => undefined }, paceMs: 250, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(result, { sent: 1, deferred: true }); assert.deepEqual(sent, [1]); assert.deepEqual(fixture.marked, [1]);
  assert.deepEqual(sleeps, [250]);
});

test('on-demand digest uses complete scored history but never replaces or consumes its snapshot', async () => {
  const fixture = ports([vacancy(1, 'abcdef')], ['abcdef', 'abcxyz']);
  const page = await onDemandDigest({ userId, locale: 'en', page: 0, minimumScore: 50, alertScore: 80, ports: fixture.value });
  assert.match(page.html, /Vacancy digest/u); assert.match(page.html, /<b>abcd<\/b>ef/u);
  assert.deepEqual(fixture.snapshots, []);
});

test('scheduled digest sends all pages then atomically advances snapshot, and send failure leaves queue unchanged', async () => {
  const vacancies = Array.from({ length: 12 }, (_, index) => vacancy(index + 1, `${String.fromCharCode(97 + index)}bcdef`));
  const fixture = ports(vacancies); const pages: number[] = [];
  const sent = await sendScheduledDigest({ userId, locale: 'en', since: null, until: new Date(), minimumScore: 50, alertScore: 80,
    ports: fixture.value, transport: { sendAlert: async () => undefined, sendDigest: async (_user, _html, page) => { pages.push(page); } } });
  assert.equal(sent, 12); assert.deepEqual(pages, [0, 1]); assert.deepEqual(fixture.snapshots, [vacancies.map((item) => item.id)]);

  const failed = ports(vacancies); let calls = 0;
  await assert.rejects(sendScheduledDigest({ userId, locale: 'en', since: null, until: new Date(), minimumScore: 50, alertScore: 80,
    ports: failed.value, transport: { sendAlert: async () => undefined, sendDigest: async () => { calls += 1; if (calls === 2) throw new Error('send'); } } }), /send/u);
  assert.deepEqual(failed.snapshots, []);
});
