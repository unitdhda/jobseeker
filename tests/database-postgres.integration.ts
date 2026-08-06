import assert from 'node:assert/strict';
import '../src/postgres.ts';
import * as d from '@jobseeker/store';
import * as sessions from '../src/telegram-state.ts';
import { activeUserWorkflow, claimUserWorkflow } from '../src/telegram/workflow-lock.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the Postgres integration test.');
const suffix = `${Date.now()}-${process.pid}`;
const userId = `integration-${suffix}`;
const sourceId = `integration-${suffix}`;
const chatId = `integration-chat-${suffix}`;
let vacancyId: number | undefined;
try {
  const legacyTables = await d.postgresQuery<{ table_name: string }>(`select table_name from information_schema.tables
    where table_schema='public' and table_name=any($1::text[]) order by table_name`,
    [['user_vacancies','profiles','scores','pending_deliveries']]);
  assert.deepEqual(legacyTables, []);
  const matchColumns = await d.postgresQuery<{ column_name: string; data_type: string }>(`select column_name,data_type
    from information_schema.columns where table_schema='public' and table_name='matches'`);
  assert.equal(matchColumns.find((column) => column.column_name === 'llm_score')?.data_type, 'integer');
  assert.equal(matchColumns.find((column) => column.column_name === 'application_artifacts')?.data_type, 'jsonb');

  const touched = await d.touchTelegramUser({ userId, chatId, displayName: 'Integration Test' });
  assert.equal(touched.status, 'unregistered');
  assert.equal((await d.requestAccess({ userId, chatId, displayName: 'Integration Test' })).user.status, 'pending');
  assert.equal((await d.setUserStatus(userId, 'approved'))?.status, 'approved');
  await sessions.setTelegramSession(userId, 'window-setup', { step: 'start' }, 60_000);
  assert.deepEqual(await sessions.getTelegramSession(userId, 'window-setup'), { step: 'start' });

  // Distinct Telegram updates and even distinct document buttons share one durable per-user lease. Only one of a
  // burst may reach parsing/profile/application work, including when requests land in different processes.
  const burst = await Promise.all([
    claimUserWorkflow(userId, 'cv-import'), claimUserWorkflow(userId, 'profile-refresh'),
    claimUserWorkflow(userId, 'tailored-cv'), claimUserWorkflow(userId, 'cover-letter'),
    claimUserWorkflow(userId, 'tailored-cv'), claimUserWorkflow(userId, 'cover-letter'),
  ]);
  const winners = burst.filter((result) => result.claimed);
  assert.equal(winners.length, 1);
  assert.ok(burst.filter((result) => !result.claimed).every((result) => result.active != null));
  const winner = winners[0]!;
  if (!winner.claimed) throw new Error('Expected one workflow lease winner.');
  await winner.lease.setKind('profile-refresh');
  assert.equal((await activeUserWorkflow(userId))?.kind, 'profile-refresh');
  await winner.lease.release();
  const afterRelease = await claimUserWorkflow(userId, 'cover-letter');
  assert.equal(afterRelease.claimed, true);
  if (afterRelease.claimed) await afterRelease.lease.release();

  const owned = await sessions.claimTelegramSession(userId, 'owned-session', { token: 'current' }, 60_000);
  assert.equal(owned.claimed, true);
  assert.equal(await sessions.releaseClaimedTelegramSession(userId, 'owned-session', 'stale'), false);
  assert.deepEqual(await sessions.getTelegramSession(userId, 'owned-session'), { token: 'current' });
  assert.equal(await sessions.releaseClaimedTelegramSession(userId, 'owned-session', 'current'), true);

  await d.saveCvSource(userId, 'cv.txt', `cv-${suffix}`, {
    text: 'Integration CV with TypeScript PostgreSQL distributed systems experience. '.repeat(5),
    document: { version: 1, blocks: [{ type: 'paragraph', text: 'Integration CV' }] },
    sourceFormat: 'txt', mediaType: 'text/plain', parserName: 'integration', parserVersion: '1',
  });
  await d.saveSearchProfile(userId, 'hh', { searches: [{ text: 'distributed systems' }] });
  await d.saveDeliverySettings(userId, { startMinutes: 540, endMinutes: 1320, digestMinutes: 570, timezone: '+03:00' });
  assert.equal(await d.getCvHash(userId), `cv-${suffix}`);

  const saved = await d.upsertVacancy({ source: 'hh', sourceId, name: 'Postgres Integration Engineer',
    employer: 'Integration Employer', area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null,
    salaryGross: null, experience: 'senior', employment: 'full', schedule: 'full', workFormat: 'remote',
    description: 'Build distributed TypeScript services backed by PostgreSQL.', keySkills: ['TypeScript', 'PostgreSQL'],
    url: `https://hh.ru/vacancy/${Date.now()}`, publishedAt: '', sourceQuery: 'integration', contentHash: `content-${suffix}` });
  vacancyId = saved.id;
  assert.equal(await d.createMatches([{ userId, vacancyId, lexicalScore: 91 }], new Date()), 1);
  assert.deepEqual(await d.claimForScoring(userId, 1), [vacancyId]);
  await d.saveScore(userId, vacancyId, 91, 'Backend', 'Strong integration match', ['TypeScript'], ['None'], false);
  assert.equal((await d.getScoredVacancy(userId, vacancyId))?.score, 91);

  await d.beginApplication(userId, vacancyId);
  await d.markApplicationReady(userId, vacancyId);
  const deliveredAt = new Date().toISOString();
  await d.saveDeliveredArtifact(userId, vacancyId, 'cv', { cvSha256: `cv-${suffix}`, fileId: 'telegram-file-id', deliveredAt });
  await d.saveDeliveredArtifact(userId, vacancyId, 'letter', { cvSha256: `cv-${suffix}`, text: 'Integration letter', deliveredAt });
  await d.markApplicationDelivered(userId, vacancyId, 'cv');

  const exported = await d.exportUserData(userId) as { cvSource: unknown; deliveredApplicationArtifacts: Array<{
    artifacts: { cv?: { fileId?: string }; letter?: { text?: string } } }> };
  assert.ok(exported.cvSource);
  assert.equal(exported.deliveredApplicationArtifacts.length, 1);
  assert.equal(exported.deliveredApplicationArtifacts[0]?.artifacts.cv?.fileId, 'telegram-file-id');
  assert.equal(exported.deliveredApplicationArtifacts[0]?.artifacts.letter?.text, 'Integration letter');

  await d.deleteUserData(userId);
  assert.equal(await d.getCvHash(userId), null);
  assert.equal(await d.deliveredArtifact(userId, vacancyId, 'cv'), null);
  assert.equal((await d.getTelegramUser(userId))?.status, 'approved'); // access identity remains by design
  console.info('Postgres business repository integration passed.');
} finally {
  await d.postgresQuery('delete from users where user_id=$1', [userId]).catch(() => undefined);
  if (vacancyId != null) await d.postgresQuery('delete from vacancies where id=$1', [vacancyId]).catch(() => undefined);
  await d.closePostgresPool();
}
