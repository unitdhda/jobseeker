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

const d = await import('../src/lib/database-sqlite.ts');
const { VacancySearchCollector } = await import('../src/lib/vacancy-search-collector.ts');
const schedules = await import('../src/lib/schedules.ts');
const extracted = (label: string) => ({
  text: `${label} reusable CV content with extensive experience, responsibilities, achievements, education, skills, languages, and contacts. `.repeat(2),
  document: { version: 1 as const, blocks: [{ type: 'paragraph' as const, text: `${label} CV` }] },
  sourceFormat: 'txt' as const, mediaType: 'text/plain', parserName: 'test', parserVersion: '1',
});

function addUser(userId: string): void {
  d.requestAccess({ userId, chatId: userId, displayName: `User ${userId}` });
  d.setUserStatus(userId, 'approved');
  d.saveCvSource(userId, 'cv.txt', `cv-${userId}`, extracted(`CV ${userId}`));
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

  await t.test('one authoritative CV source is stored per user', () => {
    addUser('1001');
    const firstHash = d.getCvHash('1001');
    d.saveCvSource('1001', 'replacement.txt', 'replacement-hash', extracted('Replacement CV'));
    assert.equal(Number(d.db.prepare("SELECT COUNT(*) count FROM cv_templates WHERE user_id='1001'").get()?.count), 1);
    assert.equal(d.getCvSource('1001')?.originalFilename, 'replacement.txt');
    assert.notEqual(d.getCvHash('1001'), firstHash);
  });

  await t.test('scores are isolated and shared vacancies are searchable with FTS5', () => {
    addUser('1001'); addUser('2002');
    const vacancy = d.upsertVacancy({ source: 'hh', sourceId: 'shared-1', name: 'Distributed Systems Engineer',
      employer: 'Shared Employer', area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null,
      experience: 'senior', employment: 'full', schedule: 'full', workFormat: 'remote',
      description: 'Build resilient event-driven services with TypeScript and PostgreSQL.', keySkills: ['TypeScript', 'PostgreSQL'],
      url: 'https://hh.ru/vacancy/1', publishedAt: '2026-01-01', sourceQuery: 'distributed', contentHash: 'shared-hash' });
    d.saveScore('1001', vacancy.id, 91, 'Systems', 'Owner summary', ['Strong TypeScript'], ['Limited scale'], false);
    d.saveScore('2002', vacancy.id, 64, 'Services', 'Second summary', [], [], false);
    assert.equal(d.getScoredVacancy('1001', vacancy.id)?.score, 91);
    assert.equal(d.getScoredVacancy('2002', vacancy.id)?.score, 64);
    assert.equal(d.searchScoredVacancies('1001', 'distributed TypeScript')[0]?.id, vacancy.id);
    assert.equal(d.searchScoredVacancies('2002', 'PostgreSQL')[0]?.score, 64);
    const alert = d.unsentHighScoreVacancies('1001', 80)[0];
    assert.equal(alert?.primaryTrack, 'Systems'); assert.deepEqual(alert?.reasons, ['Strong TypeScript']);
    d.markAlerted('1001', vacancy.id);
    assert.equal(Number(d.db.prepare("SELECT COUNT(*) count FROM score_alert_details WHERE user_id='1001'").get()?.count), 0);
    assert.deepEqual(d.db.prepare('PRAGMA table_info(scores)').all().map((row) => String(row.name)),
      ['user_id','vacancy_id','score']);
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

  await t.test('candidate prefilter scores are isolated per user', () => {
    const input = { source: 'geekjob', sourceId: 'per-user-score', url: 'https://geekjob.ru/vacancy/aabbcc',
      searchName: 'shared listing', title: 'Shared candidate' };
    d.recordVacancyCandidate('1001', input); d.recordVacancyCandidate('2002', input);
    const ownerCandidate = d.candidatesNeedingPrefilter('1001', 'owner-context', 100)
      .find((item) => item.sourceId === input.sourceId)!;
    const secondCandidate = d.candidatesNeedingPrefilter('2002', 'second-context', 100)
      .find((item) => item.sourceId === input.sourceId)!;
    const score = (combinedScore: number, filtered: boolean) => ({ regexScore: combinedScore,
      embeddingCosine: 0, embeddingScore: 0, semanticCosine: null, semanticScore: null,
      semanticStatus: 'disabled' as const, combinedScore, filtered, auditSelected: false, reasons: ['test'] });
    d.saveCandidatePrefilter('1001', ownerCandidate, 'owner-context', score(90, false));
    d.saveCandidatePrefilter('2002', secondCandidate, 'second-context', score(5, true));
    assert.equal(d.rankedCandidateQueueForUsers(['1001'], 100).some((item) => item.sourceId === input.sourceId), true);
    assert.equal(d.rankedCandidateQueueForUsers(['2002'], 100).some((item) => item.sourceId === input.sourceId), false);
    d.markCandidateClosed(ownerCandidate);
  });

  await t.test('normalized vacancies remain scoped to discovering users', () => {
    d.recordVacancyCandidate('1001', { source: 'hh', sourceId: 'attributed-only', url: 'https://hh.ru/vacancy/3',
      searchName: 'owner role', title: 'Owner-specific vacancy' });
    const saved = d.upsertVacancy({ source: 'hh', sourceId: 'attributed-only', name: 'Owner-specific vacancy',
      employer: 'Scoped Employer', area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null,
      experience: '', employment: '', schedule: '', workFormat: '', description: 'Only discovered for the owner.', keySkills: [],
      url: 'https://hh.ru/vacancy/3', publishedAt: '2026-01-02', sourceQuery: 'owner role', contentHash: 'attributed-hash' });
    const candidate = d.candidatesNeedingPrefilter('1001', 'scope-context', 100)
      .find((item) => item.sourceId === 'attributed-only')!;
    d.markCandidateNormalized(candidate, saved.id);
    assert.equal(d.pendingVacancies('1001', 100).some((item) => item.id === saved.id), true);
    assert.equal(d.pendingVacancies('2002', 100).some((item) => item.id === saved.id), false);
    assert.equal(d.vacanciesNeedingPrefilter('2002', 'scope-context', 100).some((item) => item.id === saved.id), false);
  });

  await t.test('search discovery and normalization enforce per-user limits with shared deduplication', async () => {
    const collector = new VacancySearchCollector('1001', 10);
    for (let index = 0; index < 12; index++) await collector.record({
      source: 'hh', sourceId: String(10_000 + index), url: `https://hh.ru/vacancy/${10_000 + index}`,
      searchName: 'collector test', title: `Collector vacancy ${index}`,
    });
    assert.deepEqual(collector.result(), { seen: 10, discovered: 10 });

    const addCandidate = (userId: string, sourceId: string, score: number) => {
      d.recordVacancyCandidate(userId, { source: 'habr', sourceId,
        url: `https://career.habr.com/vacancies/${sourceId}`, searchName: `user ${userId}`,
        title: `Ranked vacancy ${sourceId}` });
      const candidate = d.candidatesNeedingPrefilter(userId, `context-${userId}`, 100)
        .find((item) => item.sourceId === sourceId)!;
      d.saveCandidatePrefilter(userId, candidate, `context-${userId}`, { regexScore: score,
        embeddingCosine: score / 100, embeddingScore: score, semanticCosine: null, semanticScore: null,
        semanticStatus: 'disabled', combinedScore: score, filtered: false, auditSelected: false, reasons: ['test'] });
    };
    addCandidate('1001', '9000', 100); addCandidate('2002', '9000', 100);
    for (let index = 1; index <= 10; index++) {
      addCandidate('1001', String(9_000 + index), 100 - index);
      addCandidate('2002', String(9_100 + index), 100 - index);
    }
    const selected = d.rankedCandidateQueueForUsers(['1001', '2002'], 10);
    assert.equal(selected.length, 19, 'the shared top candidate is normalized only once');
    const selectedIds = new Set(selected.map((candidate) => candidate.sourceId));
    for (const userId of ['1001', '2002']) {
      const attributed = d.db.prepare("SELECT source_id FROM candidate_discoveries WHERE user_id=? AND source='habr'")
        .all(userId).filter((row) => selectedIds.has(String(row.source_id)));
      assert.equal(attributed.length, 10, `${userId} receives ten attributed candidates`);
    }
  });

  await t.test('settled one-shot agent history is purged but active recovery state is preserved', () => {
    d.db.exec(`CREATE TABLE flue_agent_submissions(submission_id TEXT,session_key TEXT,status TEXT);
      CREATE TABLE flue_submission_chunks(submission_id TEXT);
      CREATE TABLE flue_conversation_streams(path TEXT);
      CREATE TABLE flue_conversation_stream_batches(path TEXT,submission_id TEXT);
      CREATE TABLE flue_conversation_stream_batch_chunks(path TEXT);
      CREATE TABLE flue_attachments(stream_path TEXT);
      CREATE TABLE flue_attachment_chunks(stream_path TEXT);`);
    const settledKey = 'agent-session:["score-vacancy","settled-test","default","default"]';
    d.db.prepare("INSERT INTO flue_agent_submissions VALUES ('settled-submission',?,'settled')").run(settledKey);
    d.db.prepare("INSERT INTO flue_conversation_streams VALUES ('agents/score-vacancy/settled-test')").run();
    assert.equal(d.purgeSettledAgentSession('score-vacancy', 'settled-test'), true);
    assert.equal(Number(d.db.prepare('SELECT COUNT(*) count FROM flue_agent_submissions').get()?.count), 0);
    const activeKey = 'agent-session:["score-vacancy","active-test","default","default"]';
    d.db.prepare("INSERT INTO flue_agent_submissions VALUES ('active-submission',?,'running')").run(activeKey);
    assert.equal(d.purgeSettledAgentSession('score-vacancy', 'active-test'), false);
    assert.equal(Number(d.db.prepare('SELECT COUNT(*) count FROM flue_agent_submissions').get()?.count), 1);
  });

  await t.test('usage, export, delivery windows, and personal deletion', async () => {
    d.recordUsage('2002', 'score'); d.recordUsage('2002', 'application');
    assert.equal(d.usageInLast24Hours('2002', 'score'), 1);
    assert.equal(schedules.normalizeUtcOffset('+3'), '+03:00');
    assert.equal(schedules.normalizeUtcOffset('-5:30'), '-05:30');
    assert.throws(() => schedules.normalizeUtcOffset('+14:30'), /UTC/);
    await schedules.updateDeliverySettings('2002', '22:00', '08:00', '09:30', '+3:30');
    assert.equal(await schedules.deliverySettingsStatus('2002'), 'уведомления: 22:00–08:00; дайджест: 09:30; UTC+03:30');
    assert.equal(await schedules.isWithinDeliveryWindow('2002', new Date('2026-01-01T20:00:00Z')), true);
    assert.equal(await schedules.isDigestDue('2002', new Date('2026-01-01T05:59:00Z')), false);
    assert.equal(await schedules.isDigestDue('2002', new Date('2026-01-01T06:00:00Z')), true);
    d.markDigestRun('2002', '2026-01-01T06:00:00.000Z');
    assert.equal(await schedules.isDigestDue('2002', new Date('2026-01-01T20:00:00Z')), false);
    assert.equal(await schedules.isDigestDue('2002', new Date('2026-01-02T06:00:00Z')), true);
    const digest = d.digestVacancies('2002', 50, 80, null);
    assert.equal(digest.length, 1);
    const scoredAt = String(d.db.prepare("SELECT score_updated_at FROM user_vacancies WHERE user_id='2002'").get()?.score_updated_at);
    assert.equal(d.digestVacancies('2002', 50, 80, scoredAt).length, 0, 'digest only includes later scores');
    d.markDigested('2002', digest.map((vacancy) => vacancy.id));
    assert.equal(d.digestVacancies('2002', 50, 80, null).length, 0, 'seen digest entries stay excluded');
    const exported = d.exportUserData('2002');
    assert.deepEqual(Object.keys(exported).sort(), ['careerProfile','cvSource','normalizedDocument','scores','searchProfiles']);
    assert.equal(exported.careerProfile, null);
    assert.equal(typeof exported.cvSource, 'string');
    assert.ok((exported.normalizedDocument as { blocks: unknown[] }).blocks.length > 0);
    const exportedScore = (exported.scores as Array<Record<string, unknown>>)[0];
    assert.deepEqual(Object.keys(exportedScore).sort(), ['score','url']);
    assert.equal(exportedScore.score, 64);
    d.deleteUserData('2002');
    assert.equal(d.getTelegramUser('2002')?.status, 'approved');
    for (const table of ['cv_templates','scores','search_profiles','user_vacancies','candidate_prefilter_scores','candidate_discoveries','usage_events']) {
      assert.equal(Number(d.db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE user_id='2002'`).get()?.count), 0, table);
    }
    assert.equal(d.db.prepare("SELECT 1 FROM vacancies WHERE source='hh' AND source_id='shared-1'").get() != null, true);
  });
});

d.db.close();
rmSync(directory, { recursive: true, force: true });
