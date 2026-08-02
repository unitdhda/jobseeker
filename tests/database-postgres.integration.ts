import assert from 'node:assert/strict';
import { closePostgresPool, postgresQuery } from '../src/lib/postgres.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the Postgres integration test.');
const d = await import('../src/lib/database.ts');
const sessions = await import('../src/lib/telegram-sessions.ts');
const webhook = await import('../src/lib/telegram-webhook-receipts.ts');
const suffix = `${Date.now()}-${process.pid}`;
const userId = `integration-${suffix}`;
const sourceId = `integration-${suffix}`;
const chatId = `integration-chat-${suffix}`;
let vacancyId: number | undefined;
try {
  const legacyTables = await postgresQuery<{ table_name: string }>(`select table_name from information_schema.tables
    where table_schema='public' and table_name=any($1::text[]) order by table_name`,
    [['app_migrations','applications','global_scheduler_settings','pending_deliveries','scores','telegram_user_update_leases']]);
  assert.deepEqual(legacyTables, []);
  const consolidatedColumns = await postgresQuery<{ column_name: string; data_type: string }>(`select column_name,data_type
    from information_schema.columns where table_schema='public' and table_name='user_vacancies'`);
  assert.equal(consolidatedColumns.find((column) => column.column_name === 'score')?.data_type, 'integer');
  assert.equal(consolidatedColumns.find((column) => column.column_name === 'application_updated_at')?.data_type,
    'timestamp with time zone');

  const touched = await d.touchTelegramUser({ userId, chatId, displayName: 'Integration Test' });
  assert.equal(touched.status, 'unregistered');
  assert.equal((await d.requestAccess({ userId, chatId, displayName: 'Integration Test' })).user.status, 'pending');
  assert.equal((await d.setUserStatus(userId, 'approved'))?.status, 'approved');
  await sessions.setTelegramSession(userId, 'window-setup', { step: 'start' }, 60_000);
  assert.deepEqual(await sessions.getTelegramSession(userId, 'window-setup'), { step: 'start' });
  assert.equal((await sessions.claimTelegramSession(userId, 'cv-cooldown', {}, 60_000)).claimed, true);
  assert.equal((await sessions.claimTelegramSession(userId, 'cv-cooldown', {}, 60_000)).claimed, false);
  const updateId = 7_000_000_000_000_000 + process.pid;
  assert.equal(await webhook.claimTelegramUpdate(updateId), true);
  await webhook.completeTelegramUpdate(updateId);
  assert.equal(await webhook.claimTelegramUpdate(updateId), false);

  await d.saveCvSource(userId, 'cv.txt', `cv-${suffix}`, {
    text: 'Integration CV with TypeScript PostgreSQL distributed systems experience. '.repeat(5),
    document: { version: 1, blocks: [{ type: 'paragraph', text: 'Integration CV' }] },
    sourceFormat: 'txt', mediaType: 'text/plain', parserName: 'integration', parserVersion: '1',
  });
  assert.equal(await d.getCvHash(userId), `cv-${suffix}`);
  await d.saveSearchProfile(userId, 'hh', { searches: [{ text: 'distributed systems' }] });
  assert.deepEqual(await d.getSearchProfile(userId, 'hh'), { searches: [{ text: 'distributed systems' }] });
  await d.saveDeliverySettings(userId, { startMinutes: 540, endMinutes: 1320, digestMinutes: 570, timezone: '+03:00' });
  assert.equal((await d.getDeliverySettings(userId))?.digestMinutes, 570);

  const saved = await d.upsertVacancy({ source: 'hh', sourceId, name: 'Postgres Integration Engineer', employer: 'Integration Employer',
    area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null, experience: 'senior',
    employment: 'full', schedule: 'full', workFormat: 'remote', description: 'Build distributed TypeScript services backed by PostgreSQL.',
    keySkills: ['TypeScript', 'PostgreSQL'], url: `https://hh.ru/vacancy/${Date.now()}`, publishedAt: '',
    sourceQuery: 'integration', contentHash: `content-${suffix}` });
  vacancyId = saved.id;
  assert.equal(saved.duplicate, false);
  await d.savePrefilterScore(userId, vacancyId, `context-${suffix}`, `content-${suffix}`, { regexScore: 90,
    lexicalCosine: 0.8, lexicalScore: 90, combinedScore: 90, filtered: false, auditSelected: false, reasons: ['integration'] });
  assert.equal((await d.prefilterQueueStats(userId, `context-${suffix}`)).queued, 1);
  assert.equal((await d.rankedPendingVacancies(userId, `context-${suffix}`, 5))[0]?.id, vacancyId);
  await d.saveScore(userId, vacancyId, 91, 'Backend', 'Strong integration match', ['TypeScript'], ['None'], false);
  assert.equal((await d.getScoredVacancy(userId, vacancyId))?.score, 91);
  assert.equal((await d.searchScoredVacancies(userId, 'Postgres Integration'))[0]?.id, vacancyId);
  assert.equal((await d.unsentHighScoreVacancies(userId, 80))[0]?.primaryTrack, 'Backend');
  await d.markAlerted(userId, vacancyId);

  assert.equal(await d.recordVacancyCandidate(userId, { source: 'habr', sourceId, url: `https://career.habr.com/vacancies/${sourceId}`,
    searchName: 'integration', title: 'Integration Candidate', publishedAt: '' }), true);
  const candidate = (await d.candidatesNeedingPrefilter(userId, 'different-context', 10)).find((item) => item.sourceId === sourceId);
  assert.ok(candidate);
  await d.saveCandidatePrefilter(userId, candidate, 'different-context', { regexScore: 88, lexicalCosine: 0.7,
    lexicalScore: 85, combinedScore: 87, filtered: false, auditSelected: false, reasons: ['integration'] });
  assert.equal((await d.rankedCandidateQueueForUsers([userId], 5))[0]?.sourceId, sourceId);
  const normalizedCandidate = await d.upsertVacancy({ source: 'habr', sourceId, name: 'Integration Candidate',
    employer: 'Habr Integration Employer', area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null,
    salaryGross: null, experience: '', employment: '', schedule: '', workFormat: 'remote',
    description: 'Normalized candidate integration vacancy.', keySkills: ['PostgreSQL'],
    url: `https://career.habr.com/vacancies/${sourceId}`, publishedAt: '', sourceQuery: 'integration',
    contentHash: `candidate-content-${suffix}` });
  assert.equal(normalizedCandidate.duplicate, false);
  await d.markCandidateNormalized(candidate, normalizedCandidate.id);
  assert.equal((await d.getVacancy(normalizedCandidate.id))?.sourceId, sourceId);
  await d.recordUsage(userId, 'score');
  assert.equal(await d.usageInLast24Hours(userId, 'score'), 1);
  assert.equal((await d.userUsageSummaries()).some((summary) => summary.userId === userId && summary.scores24h === 1), true);
  assert.equal((await d.exportUserData(userId)).cvSource != null, true);
  await d.deleteUserData(userId);
  assert.equal(await d.getCvHash(userId), null);
  console.info('Postgres business repository integration passed.');
} finally {
  await postgresQuery('delete from users where user_id=$1', [userId]).catch(() => undefined);
  await postgresQuery('delete from vacancies where source_id=$1', [sourceId]).catch(() => undefined);
  if (vacancyId != null) await postgresQuery('delete from vacancies where id=$1', [vacancyId]).catch(() => undefined);
  await closePostgresPool();
}
