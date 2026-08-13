import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '@jobseeker/store';

const url = process.env.JOBSEEKER_MIGRATED_DATABASE_URL;
const run = url ? test : test.skip;

run('0.2.0 repositories read migrated 0.1.12 production-shaped data', { timeout: 120_000 }, async () => {
  const store = createStore({ databaseUrl: url!, poolMax: 2,
    ssl: process.env.JOBSEEKER_MIGRATED_DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : false,
    settings: { accessRequestCooldownMinutes: 60, prefilterMaxAgeDays: 30,
      searchPlatforms: ['hh', 'habr', 'hirehi'], digestMinScore: 50, alertScore: 80,
      timezone: 'Europe/Moscow', safeVacancyUrl: (_source, value) => new URL(value).href } });
  try {
    assert.equal(await store.ready(), 'postgres');
    const users = await store.approvedUsers(true); assert.equal(users.length, 9);
    for (const user of users) {
      assert.ok(await store.getCvSource(user.userId));
      assert.ok(await store.getCareerProfile(user.userId));
      assert.ok(await store.getDeliverySettings(user.userId));
    }
    const roles = await store.roleTrackTitles(); assert.ok(roles.length > 0);
    const equivalences = await store.loadRoleEquivalences(); assert.equal(equivalences.length, 5);
    const titleIdf = await store.loadIdfVocabulary('title'); const bodyIdf = await store.loadIdfVocabulary('body');
    assert.ok(titleIdf && titleIdf.entries.length > 0); assert.ok(bodyIdf && bodyIdf.entries.length > 0);
    const usage = await store.llmUsageSummary(); assert.ok(usage.turnsTotal > 8_000); assert.equal(usage.hours.length, 25);
    const scraper = await store.scraperSummary(); assert.equal(scraper.hours.length, 25); assert.ok(scraper.units.length > 0);
    const counts = await store.admin.query<{ users: string; vacancies: string; matches: string; artifacts: string }>(`select
      (select count(*) from users) users,(select count(*) from vacancies) vacancies,
      (select count(*) from matches) matches,
      (select count(*) from matches where application_artifacts<>'{}'::jsonb) artifacts`);
    assert.equal(Number(counts.rows[0]?.users), 16); assert.ok(Number(counts.rows[0]?.vacancies) > 8_700);
    assert.ok(Number(counts.rows[0]?.matches) > 10_600); assert.ok(Number(counts.rows[0]?.artifacts) > 20);
  } finally { await store.close(); }
});
