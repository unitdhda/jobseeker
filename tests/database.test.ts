import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'jobseeker-db-test-'));
process.env.DATABASE_PATH = join(directory, 'test.db');
process.env.TELEGRAM_USER_ID = '1001';
process.env.TELEGRAM_CHAT_ID = '1001';
process.env.RUN_JOBS = 'false';
process.env.TELEGRAM_POLLING = 'false';

const d = await import('../src/lib/database.ts');
const schedules = await import('../src/lib/schedules.ts');
const extracted = (label: string) => ({
  text: `${label} reusable CV content with extensive experience, responsibilities, achievements, education, skills, languages, and contacts. `.repeat(2),
  document: { version: 1 as const, blocks: [{ type: 'paragraph' as const, text: `${label} CV` }] },
  sourceFormat: 'txt' as const, mediaType: 'text/plain', parserName: 'test', parserVersion: '1',
});

function addUser(userId: string): void {
  d.requestAccess({ userId, chatId: userId, displayName: `User ${userId}` });
  d.setUserStatus(userId, 'approved');
  d.saveCvTemplate(userId, 'ru', 'ru.txt', `ru-${userId}`, extracted(`RU ${userId}`));
  d.saveCvTemplate(userId, 'en', 'en.txt', `en-${userId}`, extracted(`EN ${userId}`));
}

await test('multi-user database behavior', async (t) => {
  await t.test('sensitive database paths use owner-only permissions', () => {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(process.env.DATABASE_PATH!).mode & 0o777, 0o600);
  });
  await t.test('approval, rejection, revocation, and re-request', () => {
    const first = d.requestAccess({ userId: '2002', chatId: '2002', displayName: 'Second' });
    assert.equal(first.user.status, 'pending');
    assert.equal(first.notifyOwner, true);
    assert.equal(d.requestAccess({ userId: '2002', chatId: '2002', displayName: 'Second' }).notifyOwner, false);
    d.setUserStatus('2002', 'rejected');
    const blocked = d.requestAccess({ userId: '2002', chatId: '2002', displayName: 'Second' });
    assert.equal(blocked.user.status, 'rejected'); assert.ok(blocked.retryAfterSeconds > 0);
    d.db.prepare("UPDATE telegram_users SET requested_at=datetime('now','-2 days') WHERE user_id='2002'").run();
    assert.equal(d.requestAccess({ userId: '2002', chatId: '2002', displayName: 'Second' }).user.status, 'pending');
    d.setUserStatus('2002', 'approved');
    d.setUserStatus('2002', 'revoked');
    assert.equal(d.getTelegramUser('2002')?.status, 'revoked');
    d.requestAccess({ userId: '2002', chatId: '2002', displayName: 'Second' });
    d.setUserStatus('2002', 'approved');
  });

  await t.test('scores are isolated and shared vacancies are searchable with FTS5', () => {
    addUser('1001'); addUser('2002');
    const vacancy = d.upsertVacancy({ source: 'hh', sourceId: 'shared-1', name: 'Distributed Systems Engineer',
      employer: 'Shared Employer', area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null,
      experience: 'senior', employment: 'full', schedule: 'full', workFormat: 'remote',
      description: 'Build resilient event-driven services with TypeScript and PostgreSQL.', keySkills: ['TypeScript', 'PostgreSQL'],
      url: 'https://hh.ru/vacancy/1', publishedAt: '2026-01-01', sourceQuery: 'distributed', contentHash: 'shared-hash' });
    d.saveScore('1001', vacancy.id, 91, 'Systems', 'Owner summary', [], [], false);
    d.saveScore('2002', vacancy.id, 64, 'Services', 'Second summary', [], [], false);
    assert.equal(d.getScoredVacancy('1001', vacancy.id)?.score, 91);
    assert.equal(d.getScoredVacancy('2002', vacancy.id)?.score, 64);
    assert.equal(d.searchScoredVacancies('1001', 'distributed TypeScript')[0]?.id, vacancy.id);
    assert.equal(d.searchScoredVacancies('2002', 'PostgreSQL')[0]?.score, 64);
  });

  await t.test('candidate discovery attribution is per user', () => {
    const input = { source: 'hh', sourceId: 'candidate-1', url: 'https://hh.ru/vacancy/2',
      searchName: 'systems', title: 'Systems Engineer', summary: 'TypeScript services' };
    d.recordVacancyCandidate('1001', input);
    d.recordVacancyCandidate('2002', { ...input, searchName: 'backend systems' });
    const rows = d.db.prepare("SELECT user_id,search_name FROM candidate_discoveries WHERE source='hh' AND source_id='candidate-1' ORDER BY user_id").all();
    assert.deepEqual(rows.map((row) => [String(row.user_id), String(row.search_name)]),
      [['1001', 'systems'], ['2002', 'backend systems']]);
  });

  await t.test('usage, export, delivery windows, and personal deletion', () => {
    d.recordUsage('2002', 'score'); d.recordUsage('2002', 'application');
    assert.equal(d.usageInLast24Hours('2002', 'score'), 1);
    schedules.updateDeliveryWindow('2002', '22:00-08:00 Europe/Moscow');
    const exported = d.exportUserData('2002');
    assert.equal((exported.cvTemplates as unknown[]).length, 2);
    assert.ok((exported.scores as unknown[]).length >= 1);
    assert.equal((exported.deliveryWindow as { timezone: string }).timezone, 'Europe/Moscow');
    d.deleteUserData('2002');
    assert.equal(d.getTelegramUser('2002')?.status, 'approved');
    for (const table of ['cv_templates','scores','search_profiles','user_vacancies','candidate_discoveries','usage_events']) {
      assert.equal(Number(d.db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE user_id='2002'`).get()?.count), 0, table);
    }
    assert.equal(d.db.prepare("SELECT 1 FROM vacancies WHERE source='hh' AND source_id='shared-1'").get() != null, true);
  });
});

d.db.close();
rmSync(directory, { recursive: true, force: true });
