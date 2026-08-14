import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { parseCvContentHash, parseSourceKey, parseSourceVacancyId, parseUserId } from '@jobseeker/engine/contracts';
import { careerProfileSchema } from '@jobseeker/engine/prefilter';
import { identityRoleResolver } from '@jobseeker/engine/equivalence';
import { uniformIdfLookups } from '@jobseeker/engine/idf';
import type { Store, Vacancy } from '@jobseeker/store';
import { parseConfig } from '../src/config.ts';
import { createApplicationPorts, createProfileRefreshPorts, llmUsageInput } from '../src/workflow-adapters.ts';
import type { MatchingVocabularies } from '../src/matching-vocabularies.ts';

const userId = parseUserId('1'); const hash = parseCvContentHash('a'.repeat(64)); const source = parseSourceKey('test');
const config = parseConfig({ TELEGRAM_MODE: 'off', USER_DAILY_APPLICATION_LIMIT: '2', USER_DAILY_COVER_LETTER_LIMIT: '3',
  USER_DAILY_SEARCH_PROFILE_LIMIT: '2', PREFILTER_MIN_SCORE: '20' });
const career = v.parse(careerProfileSchema, { version: 1, tracks: [{ name: 'Backend Engineer', titleVariants: ['Backend Engineer'],
  coreSkills: ['TypeScript'], evidence: ['Backend TypeScript API development'] }] });
function vacancy(id: number, matching = true): Vacancy {
  return { id, applyId: 'abcdef', lifecycleStatus: 'normalized', source, sourceId: parseSourceVacancyId(String(id)),
    name: matching ? 'Backend Engineer' : 'Accountant', employer: 'Acme', area: 'Remote', salary: null,
    experience: { kind: 'unspecified' }, employment: 'full-time', schedule: 'standard', workFormat: 'remote',
    description: matching ? 'TypeScript backend API development' : 'Financial ledger and tax reporting',
    keySkills: matching ? ['TypeScript'] : ['Accounting'], url: new URL(`https://example.test/${id}`),
    publishedAt: new Date(), sourceQuery: matching ? 'backend' : 'accounting' };
}
test('LLM usage adapter preserves durable input, output, cache, total, and cost classes', () => {
  assert.deepEqual(llmUsageInput({ input: 10, output: 5, cacheRead: 7, cacheWrite: 3, totalTokens: 15,
    cost: { input: .1, output: .2, cacheRead: .03, cacheWrite: .04, total: .37 } }), {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, totalTokens: 15, costUsd: .37,
  });
});

function vocabularies(): MatchingVocabularies {
  const snapshot = { roleResolver: identityRoleResolver, idfLookups: uniformIdfLookups, loaded: true, rebuiltAt: null };
  return { snapshot: () => snapshot, load: async () => snapshot, refreshEquivalences: async () => snapshot,
    rebuild: async () => snapshot };
}

test('profile adapter reserves usage before calls and pages recent stock through only the refreshed user lens', async () => {
  const events: string[] = []; const created: number[][] = []; let page = 0;
  const store = {
    getCvSource: async () => ({ hash, text: 'Backend Engineer TypeScript backend API development', document: { version: 1, blocks: [] } }),
    getCvHash: async () => hash, getCareerProfile: async () => ({ cvHash: hash, profile: career }),
    getSearchProfile: async () => null, saveSearchProfile: async () => undefined, saveCareerProfile: async () => undefined,
    activeUnitQueries: async () => [], existingCompiledUnits: async () => [], applyDemand: async () => undefined,
    usageInLast24Hours: async () => 0, recordUsage: async (_user: unknown, kind: string, agent: string) => { events.push(`${kind}:${agent}`); },
    recordLlmUsageEvent: async () => undefined,
    recentNormalizedVacancyIds: async () => { page += 1; return page === 1 ? [1, 2] : []; },
    getVacancy: async (id: number) => vacancy(id, id === 1),
    createMatches: async (items: readonly { vacancyId: number }[]) => { created.push(items.map((item) => item.vacancyId)); return items.length; },
  } as unknown as Store;
  const ports = createProfileRefreshPorts({ store, config, vocabularies: vocabularies(), backfillBatchSize: 2 });
  await ports.reserveProfileUsage(userId, 'career-profile'); await ports.backfillRecentStock(userId);
  assert.deepEqual(events, ['search-profile:career-profile']); assert.equal(page, 2); assert.deepEqual(created, [[1]]);
});

test('profile limit rejects before recording and application limits are checked independently without pre-delivery writes', async () => {
  const records: string[] = []; let profileUsed = 2; const applicationUsed = { cv: 2, letter: 2 };
  const store = {
    usageInLast24Hours: async (_user: unknown, kind: string, agent?: string) => kind === 'search-profile' ? profileUsed
      : agent === 'tailor-application' ? applicationUsed.cv : applicationUsed.letter,
    recordUsage: async (_user: unknown, kind: string, agent: string) => { records.push(`${kind}:${agent}`); },
    getCvSource: async () => null, getCvHash: async () => hash, getVacancy: async () => null, deliveredArtifact: async () => null,
    beginApplication: async () => true, markApplicationReady: async () => true, failApplication: async () => true,
    recordLlmUsageEvent: async () => undefined,
    getCareerProfile: async () => null, getSearchProfile: async () => null, saveSearchProfile: async () => undefined,
    saveCareerProfile: async () => undefined, activeUnitQueries: async () => [], existingCompiledUnits: async () => [],
    applyDemand: async () => undefined, recentNormalizedVacancyIds: async () => [], createMatches: async () => 0,
  } as unknown as Store;
  const profiles = createProfileRefreshPorts({ store, config, vocabularies: vocabularies() });
  await assert.rejects(profiles.reserveProfileUsage(userId, 'career'), /limit/u); assert.deepEqual(records, []);
  profileUsed = 1; await profiles.reserveProfileUsage(userId, 'career'); assert.deepEqual(records, ['search-profile:career']);

  const applications = createApplicationPorts(store, config);
  await assert.rejects(applications.reserveApplicationUsage(userId, 'cv'), /tailored-CV limit/u);
  await applications.reserveApplicationUsage(userId, 'letter');
  assert.deepEqual(records, ['search-profile:career']);
});
