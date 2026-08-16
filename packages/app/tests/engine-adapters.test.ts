import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCvContentHash, parseSourceKey, parseSourceVacancyId, parseUserId,
  parseVacancyListingHash, type VacancyCandidate, type VacancyInput } from '@jobseeker/engine/contracts';
import { careerProfileSchema } from '@jobseeker/engine/prefilter';
import { uniformIdfLookups } from '@jobseeker/engine/idf';
import { identityRoleResolver } from '@jobseeker/engine/equivalence';
import * as v from 'valibot';
import type { TelegramUser, Vacancy } from '@jobseeker/store';
import { createMaintenanceAdapter, createMatchingAdapter, createNormalizationAdapter, discoveryTickLog } from '../src/engine-adapters.ts';
import type { MatchingVocabularies } from '../src/matching-vocabularies.ts';

const userId = parseUserId('1'); const otherUser = parseUserId('2'); const source = parseSourceKey('test');
const hash = parseCvContentHash('a'.repeat(64));
const user = (id = userId): TelegramUser => ({ userId: id, username: null, firstName: 'User', lastName: null,
  status: 'approved', isOwner: false, locale: null, localeSelected: false, createdAt: new Date(), updatedAt: new Date() });
function candidate(id: string, status: VacancyCandidate['status']): VacancyCandidate {
  return { source, sourceId: parseSourceVacancyId(id), url: new URL(`https://example.test/${id}`), searchName: 'Backend',
    title: 'Backend Engineer', summary: '', publishedAt: new Date(), listingHash: parseVacancyListingHash(id.padStart(64, '0')),
    status, attempts: 0, combinedScore: null };
}
function normalized(id: string): VacancyInput {
  return { source, sourceId: parseSourceVacancyId(id), name: 'Backend Engineer', employer: 'Acme', area: 'Remote', salary: null,
    experience: { kind: 'unspecified' }, employment: 'full-time', schedule: 'standard', workFormat: 'remote',
    description: 'TypeScript backend API development', keySkills: ['TypeScript'], url: new URL(`https://example.test/${id}`),
    publishedAt: new Date(), sourceQuery: 'Backend', contentHash: 'a'.repeat(64) as VacancyInput['contentHash'] };
}

test('normalization scales queue by approved users, groups sources, preserves refresh rows on failure, and returns new IDs', async () => {
  const queued = candidate('1', 'normalizing'); const refresh = candidate('2', 'normalized');
  const calls: string[] = [];
  const normalize = createNormalizationAdapter({
    store: {
      approvedUsers: async () => [user(), user(otherUser)],
      queuedListings: async (limit, perSource, lease) => { calls.push(`queue:${limit}:${perSource}:${lease}`); return [queued]; },
      candidatesDueForRefresh: async (limit, days) => { calls.push(`refresh:${limit}:${days}`); return [refresh]; },
      upsertVacancy: async () => ({ id: 11, needsScore: true, duplicate: false }),
      markCandidateNormalized: async (_item, id) => { calls.push(`normalized:${id}`); },
      markCandidateClosed: async () => { calls.push('closed'); },
      markCandidateFailed: async () => { calls.push('failed-new'); },
      markCandidateRefreshFailed: async () => { calls.push('failed-refresh'); },
      purgeExpiredVacancies: async (days, limit) => { calls.push(`purge:${days}:${limit}`); return 3; },
    },
    sources: { normalize: async (_source, items) => new Map(items.map((item) => [item.sourceId,
      item.sourceId === refresh.sourceId ? new Error('temporary') : normalized(item.sourceId)])) },
    config: { normalizationBatchSizePerUser: 4, normalizationPerSourceLimit: 4, normalizationClaimLeaseMinutes: 15,
      normalizeSourceConcurrency: 2, candidateRefreshBatchSize: 3,
      candidateRefreshDays: 7, vacancyRetentionDays: 30, vacancyPurgeBatchSize: 500 }, errorMessage: () => 'safe',
  });
  const report = await normalize(new Date());
  assert.deepEqual(report.vacancyIds, [11]); assert.equal(report.selected, 1); assert.equal(report.refreshed, 1);
  assert.equal(report.normalized, 1); assert.equal(report.failed, 1); assert.equal(report.expired, 3);
  assert.deepEqual(report.bySource, { test: 2 });
  assert.deepEqual(calls, ['queue:8:4:15', 'refresh:3:7', 'normalized:11', 'failed-refresh', 'purge:30:500']);
});

test('normalization marks null as closed and isolates a whole-provider failure per candidate', async () => {
  const first = candidate('1', 'normalizing'); const second = candidate('2', 'normalizing');
  const states: string[] = [];
  const normalize = createNormalizationAdapter({ store: {
    approvedUsers: async () => [user()], queuedListings: async () => [first, second], candidatesDueForRefresh: async () => [],
    upsertVacancy: async () => { throw new Error('unused'); }, markCandidateNormalized: async () => undefined,
    markCandidateClosed: async (item) => { states.push(`closed:${item.sourceId}`); },
    markCandidateFailed: async (item) => { states.push(`failed:${item.sourceId}`); },
    markCandidateRefreshFailed: async () => undefined, purgeExpiredVacancies: async () => 0,
  }, sources: { normalize: async () => { throw new Error('provider down'); } },
  config: { normalizationBatchSizePerUser: 2, normalizationPerSourceLimit: 2, normalizationClaimLeaseMinutes: 15,
    normalizeSourceConcurrency: 1, candidateRefreshBatchSize: 1,
    candidateRefreshDays: 7, vacancyRetentionDays: 30, vacancyPurgeBatchSize: 10 } });
  const failed = await normalize(new Date()); assert.equal(failed.failed, 2); assert.deepEqual(states, ['failed:1', 'failed:2']);

  states.length = 0;
  const closed = createNormalizationAdapter({ store: {
    approvedUsers: async () => [user()], queuedListings: async () => [first], candidatesDueForRefresh: async () => [],
    upsertVacancy: async () => { throw new Error('unused'); }, markCandidateNormalized: async () => undefined,
    markCandidateClosed: async (item) => { states.push(`closed:${item.sourceId}`); }, markCandidateFailed: async () => undefined,
    markCandidateRefreshFailed: async () => undefined, purgeExpiredVacancies: async () => 0,
  }, sources: { normalize: async () => new Map([[first.sourceId, null]]) }, config: {
    normalizationBatchSizePerUser: 1, normalizationPerSourceLimit: 1, normalizationClaimLeaseMinutes: 15,
    normalizeSourceConcurrency: 1, candidateRefreshBatchSize: 1,
    candidateRefreshDays: 7, vacancyRetentionDays: 30, vacancyPurgeBatchSize: 10 } });
  assert.equal((await closed(new Date())).closed, 1); assert.deepEqual(states, ['closed:1']);
});

test('normalization persists each candidate before invoking the next and isolates omission and timeout', async () => {
  const first = candidate('1', 'normalizing'); const second = candidate('2', 'normalizing');
  const third = candidate('3', 'normalizing'); const events: string[] = [];
  const normalize = createNormalizationAdapter({ store: {
    approvedUsers: async () => [user()], queuedListings: async () => [first, second, third], candidatesDueForRefresh: async () => [],
    upsertVacancy: async (value) => { events.push(`upsert:${value.sourceId}`); return { id: Number(value.sourceId), needsScore: true, duplicate: false }; },
    markCandidateNormalized: async (item) => { events.push(`saved:${item.sourceId}`); }, markCandidateClosed: async () => undefined,
    markCandidateFailed: async (item, error) => { events.push(`failed:${item.sourceId}:${error}`); },
    markCandidateRefreshFailed: async () => undefined, purgeExpiredVacancies: async () => 0,
  }, sources: { normalize: async (_provider, items) => {
    const item = items[0]!; events.push(`invoke:${item.sourceId}`);
    if (item === second) return new Map();
    if (item === third) throw new Error('timed out with private payload');
    return new Map([[item.sourceId, normalized(item.sourceId)]]);
  } }, config: { normalizationBatchSizePerUser: 3, normalizationPerSourceLimit: 3, normalizationClaimLeaseMinutes: 15,
    normalizeSourceConcurrency: 1, candidateRefreshBatchSize: 1, candidateRefreshDays: 7,
    vacancyRetentionDays: 30, vacancyPurgeBatchSize: 10 }, errorMessage: () => 'safe timeout' });
  const report = await normalize(new Date());
  assert.equal(report.normalized, 1); assert.equal(report.failed, 2); assert.deepEqual(report.vacancyIds, [1]);
  assert.deepEqual(events, ['invoke:1', 'upsert:1', 'saved:1', 'invoke:2',
    'failed:2:safe timeout', 'invoke:3', 'failed:3:safe timeout']);
});

test('discovery log exposes only aggregate provider outcomes', () => {
  const message = discoveryTickLog({ matched: 0, stageFailures: [], tick: { due: 5, unitsRun: 2,
    platformFailures: 1, unitUpdateFailures: 0, successfulPlatforms: ['safe'], failedPlatforms: ['failed-source'],
    perPlatform: {} } });
  assert.equal(message, 'Discovery tick: due=5 run=2 failed=failed-source.');
  assert.doesNotMatch(message!, /query|vacancy|postgres|token/u);
});

const career = v.parse(careerProfileSchema, { version: 1, tracks: [{ name: 'Backend Engineer',
  titleVariants: ['Backend Engineer'], coreSkills: ['TypeScript'], evidence: ['TypeScript backend development'] }] });
function vacancy(id: number): Vacancy { return { id, applyId: 'abcdef', lifecycleStatus: 'normalized', ...normalized(String(id)) }; }

test('matching loads approved lenses and vocabulary once, then evaluates every vacancy through the stable snapshot', async () => {
  let cvReads = 0; let profileReads = 0; let snapshots = 0; const writes: number[][] = [];
  const vocabularies = { snapshot: () => { snapshots += 1; return { roleResolver: identityRoleResolver,
    idfLookups: uniformIdfLookups, loaded: true, rebuiltAt: null }; } } as MatchingVocabularies;
  const match = createMatchingAdapter({ store: {
    approvedUsers: async () => [user(), user(otherUser)],
    getCvSource: async (id) => { cvReads += 1; return { hash, text: id === userId ? 'Backend Engineer TypeScript backend API development' : 'Other work' }; },
    getCareerProfile: async <TResult>(id: typeof userId) => {
      profileReads += 1;
      return (id === userId ? { cvHash: hash, profile: career } : { bad: true }) as TResult;
    },
    getVacancy: async (id) => vacancy(id),
    createMatches: async (items) => { writes.push(items.map((item) => item.vacancyId)); return items.length; },
  }, vocabularies, minimumScore: 20, maximumAgeDays: 30 });
  const report = await match([1, 2], new Date());
  assert.equal(cvReads, 2); assert.equal(profileReads, 2); assert.equal(snapshots, 1);
  assert.equal(report.matched, 2); assert.equal(report.failures, 1); assert.deepEqual(writes, [[1], [2]]);
});

test('hourly retirement and daily vocabulary maintenance retry failures without duplicate successful work', async () => {
  let retireCalls = 0; let rebuildCalls = 0; let failRetire = true; let failRebuild = true;
  const maintenance = createMaintenanceAdapter({ maximumAgeDays: 30, initialNow: new Date('2025-01-01T12:00:00Z'),
    expireStaleMatches: async () => { retireCalls += 1; if (failRetire) throw new Error('retire'); return 2; },
    vocabularies: { rebuild: async () => { rebuildCalls += 1; if (failRebuild) throw new Error('rebuild'); return {} as never; } } });
  const nextHour = new Date('2025-01-01T13:00:00Z');
  await assert.rejects(maintenance.retire!(nextHour), /retire/u); failRetire = false;
  assert.equal(await maintenance.retire!(nextHour), 2); assert.equal(await maintenance.retire!(nextHour), 0); assert.equal(retireCalls, 2);
  const nextDay = new Date('2025-01-02T00:00:00Z');
  await assert.rejects(maintenance.maintain!(nextDay), /rebuild/u); failRebuild = false;
  await maintenance.maintain!(nextDay); await maintenance.maintain!(nextDay); assert.equal(rebuildCalls, 2);
});
