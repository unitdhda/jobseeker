import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createStore, type StoreOptions } from '@jobseeker/store';
import {
  parseCvContentHash,
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  parseVacancyContentHash,
  type VacancyInput,
} from '@jobseeker/engine/contracts';
import type { ExtractedCvDocument } from '@jobseeker/cv/extract';

const testUrl = process.env.JOBSEEKER_TEST_DATABASE_URL;
const required = process.env.JOBSEEKER_POSTGRES_TEST_REQUIRED === '1';
const testSslRequired = process.env.JOBSEEKER_TEST_DATABASE_SSL === '1'
  || (testUrl !== undefined && new URL(testUrl).searchParams.get('sslmode') === 'require');
const testSsl = process.env.JOBSEEKER_TEST_DATABASE_TLS_INSECURE === '1'
  ? { rejectUnauthorized: false }
  : testSslRequired;

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//u, ''));
}

function isolatedUrl(url: string, schema: string): string {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get('options');
  parsed.searchParams.set('options', `${existing ? `${existing} ` : ''}-c search_path=${schema}`);
  return parsed.href;
}

const run = testUrl ? test : required ? test : test.skip;

run('PostgreSQL schema and critical store lifecycle', { timeout: 120_000 }, async () => {
  if (!testUrl) throw new Error('JOBSEEKER_TEST_DATABASE_URL is required for bun run test:postgres.');
  if (!databaseName(testUrl).toLowerCase().includes('test')
    && process.env.JOBSEEKER_ALLOW_DESTRUCTIVE_POSTGRES_TEST !== '1') {
    throw new Error('Refusing PostgreSQL integration test: database name must contain "test".');
  }

  const schema = `jobseeker_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ connectionString: testUrl, ssl: testSsl });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  const url = isolatedUrl(testUrl, schema);
  const storeOptions: StoreOptions = {
    databaseUrl: url,
    poolMax: 4,
    ssl: testSsl,
    settings: {
      telegramUserId: '1', accessRequestCooldownMinutes: 60, prefilterMaxAgeDays: 30,
      searchPlatforms: ['example'], digestMinScore: 60, alertScore: 80, timezone: 'UTC',
      safeVacancyUrl: (_source, value) => new URL(value).href,
    },
  };
  const store = createStore(storeOptions);
  const secondStore = createStore(storeOptions);

  try {
    const schemaSql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    await store.admin.query(schemaSql);
    const tables = await store.admin.query<{ table_name: string }>(`select table_name from information_schema.tables
      where table_schema=current_schema() order by table_name`);
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'accounts', 'cv_documents', 'idf_corpora', 'idf_vocabulary', 'matches', 'pending_cv_imports',
      'role_equivalences', 'search_units', 'telegram_updates', 'unit_subscriptions', 'usage_events',
      'user_state', 'users', 'vacancies',
    ]);

    const owner = parseUserId('1');
    const user = parseUserId('2');
    assert.equal((await store.getTelegramUser(owner))?.status, 'approved');
    const requested = await store.requestAccess({ userId: user, firstName: 'Ada', locale: 'en' });
    assert.equal(requested.notifyOwner, true);
    assert.equal((await store.setUserStatus(user, 'approved'))?.status, 'approved');

    const extraction: ExtractedCvDocument = {
      text: 'Ada Lovelace 2020–2024 built deterministic analytical systems and documented reusable evidence. '.repeat(2),
      document: { version: 1, blocks: [{ type: 'paragraph', text: 'Verified source evidence 2020–2024.' }] },
      sourceFormat: 'txt', mediaType: 'text/plain', parserName: 'test', parserVersion: '1',
    };
    const cvHash = parseCvContentHash('a'.repeat(64));
    await store.stageCvSource(user, 'cv.txt', cvHash, extraction);
    assert.equal(await store.getCvHash(user), null);
    assert.equal(await store.confirmStagedCvSource(user), true);
    assert.equal(await store.getCvHash(user), cvHash);

    const source = parseSourceKey('example');
    const fresh = await store.recordListingCandidate({
      source, sourceId: parseSourceVacancyId('fresh'), url: new URL('https://example.test/fresh'),
      searchName: 'Engineering', title: 'Backend Developer', publishedAt: new Date(),
    });
    const stale = await store.recordListingCandidate({
      source, sourceId: parseSourceVacancyId('stale'), url: new URL('https://example.test/stale'),
      searchName: 'Engineering', title: 'Old Vacancy', publishedAt: new Date(Date.now() - 40 * 86_400_000),
    });
    assert.equal(fresh, true);
    assert.equal(stale, false);

    const normalized: VacancyInput = {
      source, sourceId: parseSourceVacancyId('fresh'), name: 'Backend Developer', employer: 'Analytical Engines',
      area: 'Remote', salary: null, experience: { kind: 'unspecified' }, employment: 'full-time',
      schedule: 'flexible', workFormat: 'remote', description: 'Build deterministic TypeScript systems.',
      keySkills: ['TypeScript'], url: new URL('https://example.test/fresh'), publishedAt: new Date(),
      sourceQuery: 'backend', contentHash: parseVacancyContentHash('b'.repeat(64)),
    };
    const vacancy = await store.upsertVacancy(normalized);
    assert.equal(vacancy.duplicate, false);
    await store.createMatches([{
      userId: user, vacancyId: vacancy.id, score: 80, regexScore: 80, lexicalCosine: 0.2,
      titleSimilarity: 1, skillCoverage: 1, seniorityGap: null, specificity: null, lexicalCosineIdf: null,
    }], new Date());
    const unscoredSearch = await store.searchMatchedVacancies(user, 'backend');
    assert.equal(unscoredSearch.length, 1); assert.equal(unscoredSearch[0]?.score, null);
    assert.equal((await store.searchMatchedVacancies(owner, 'backend')).length, 0);
    assert.deepEqual(await store.claimMatches(user, [vacancy.id]), [vacancy.id]);
    assert.deepEqual(await store.claimMatches(user, [vacancy.id]), []);
    assert.equal(await store.savePrescore(user, vacancy.id, 85, 'test-prescore', 'v1', false), true);
    assert.deepEqual(await store.claimMatches(user, [vacancy.id]), [vacancy.id]);
    assert.equal(await store.saveScore(user, vacancy.id, 90, 'Backend', 'Strong fit', ['Evidence'], [], false,
      'test-model', { rationale: 'Full durable explanation' }), true);
    await store.admin.query('update vacancies set apply_id=$2 where id=$1', [vacancy.id, 'abcdef']);

    const second = await store.upsertVacancy({ ...normalized, sourceId: parseSourceVacancyId('second'),
      name: 'Frontend Designer', employer: 'Interface Works', description: 'Design accessible React interfaces.',
      keySkills: ['React'], url: new URL('https://example.test/second'), contentHash: parseVacancyContentHash('c'.repeat(64)) });
    await store.createMatches([{ userId: user, vacancyId: second.id, score: 70, regexScore: 70, lexicalCosine: 0.15,
      titleSimilarity: 0.8, skillCoverage: 0.7, seniorityGap: null, specificity: null, lexicalCosineIdf: null }], new Date());
    assert.deepEqual(await store.claimMatches(user, [second.id]), [second.id]);
    assert.equal(await store.saveScore(user, second.id, 75, 'Frontend', 'Good fit', ['React'], [], false,
      'test-model', { rationale: 'Second explanation' }), true);
    await store.admin.query('update vacancies set apply_id=$2 where id=$1', [second.id, 'abcxyz']);

    const unscored = await store.upsertVacancy({ ...normalized, sourceId: parseSourceVacancyId('unscored'),
      name: 'Data Analyst', employer: 'Numbers Ltd', description: 'Analyze reporting datasets.', keySkills: ['SQL'],
      url: new URL('https://example.test/unscored'), contentHash: parseVacancyContentHash('d'.repeat(64)) });
    await store.createMatches([{ userId: user, vacancyId: unscored.id, score: 60, regexScore: 60, lexicalCosine: 0.1,
      titleSimilarity: 0.7, skillCoverage: 0.6, seniorityGap: null, specificity: null, lexicalCosineIdf: null }], new Date());
    await store.admin.query('update vacancies set apply_id=$2 where id=$1', [unscored.id, 'zzzzzz']);

    assert.deepEqual(await store.scoredVacancyApplyIds(user), ['abcdef', 'abcxyz']);
    assert.equal((await store.scoredVacanciesByApplyIdPrefix(user, 'abc')).length, 2);
    assert.equal((await store.scoredVacanciesByApplyIdPrefix(user, 'abcdef'))[0]?.id, vacancy.id);
    assert.deepEqual(await store.scoredVacanciesByApplyIdPrefix(user, 'z'), []);
    assert.deepEqual(await store.scoredVacanciesByApplyIdPrefix(owner, 'abc'), []);

    await store.markAlerted(user, vacancy.id);
    assert.deepEqual((await store.getScoredVacancy(user, vacancy.id))?.explanation,
      { rationale: 'Full durable explanation' });
    assert.equal((await store.searchMatchedVacancies(user, 'TypeScript'))[0]?.score, 90);
    assert.equal((await store.userUsageSummaries()).some((summary) => summary.userId === user), true);
    assert.equal((await store.scraperSummary()).hours.length, 25);

    await store.beginApplication(user, vacancy.id, 'letter', cvHash);
    await store.markApplicationReady(user, vacancy.id);
    await store.saveDeliveredArtifact(user, vacancy.id, 'letter', {
      cvSha256: cvHash, text: 'Verified application text.',
    }, new Date());
    await store.markApplicationDelivered(user, vacancy.id, 'letter');
    const exported = await store.exportUserData(user);
    assert.equal((exported.artifacts as unknown[]).length, 1);

    const claimOne = await store.claimTelegramSession(user, 'application-workflow', { operation: 'cv' }, 5_000);
    const claimTwo = await store.claimTelegramSession(user, 'application-workflow', { operation: 'letter' }, 5_000);
    assert.equal(claimOne.claimed, true);
    assert.equal(claimTwo.claimed, false);

    const releaseOne = await store.tryAcquireSingletonLock('jobseeker-engine-loop');
    assert.ok(releaseOne);
    assert.equal(await secondStore.tryAcquireSingletonLock('jobseeker-engine-loop'), null);
    await releaseOne!();
    const releaseTwo = await secondStore.tryAcquireSingletonLock('jobseeker-engine-loop');
    assert.ok(releaseTwo);
    await releaseTwo!();

    await store.deleteUserData(user);
    assert.equal((await store.getTelegramUser(user))?.status, 'approved');
    assert.equal(await store.getCvHash(user), null);
  } finally {
    await secondStore.close();
    await store.close();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
