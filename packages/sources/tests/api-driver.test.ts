import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import {
  createApiSource,
  createSourceHttp,
  createSourceUrlPolicy,
  hashedVacancy,
  type ApiSourceDefinition,
  type SourceContext,
  type SourceHttpDependencies,
} from '../src/index.ts';
import {
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  parseVacancyListingHash,
  type VacancyCandidate,
  type VacancyCandidateInput,
} from '@jobseeker/engine/contracts';

const schema = v.strictObject({ searches: v.array(v.strictObject({ name: v.string(), text: v.string() })) });
type Search = v.InferOutput<typeof schema>['searches'][number];

function definition(): ApiSourceDefinition<typeof schema> {
  return {
    id: 'api', name: 'API', hosts: ['api.example.test'], schema,
    template: () => ({ platform: 'api', version: 1, purpose: 'test', jsonShape: {}, capabilities: {}, rules: [] }),
    searchName: (search) => search.name,
    searchUrl: (search, cursor) => `https://api.example.test/list?q=${encodeURIComponent(search.text)}&cursor=${cursor ?? ''}`,
    listingPage: (payload) => payload as { listings: readonly { sourceId: string; url: string; title: string }[]; nextCursor?: string },
    detailUrl: (candidate) => `https://api.example.test/detail/${candidate.sourceId}`,
    requestInit: (phase) => ({ method: phase === 'listing' ? 'POST' : 'GET', headers: { 'x-provider': phase },
      ...(phase === 'listing' ? { body: '{}' } : {}) }),
    vacancy(candidate, payload) {
      if ((payload as { closed?: boolean }).closed) return null;
      if ((payload as { fail?: boolean }).fail) throw new Error('bad detail');
      return hashedVacancy({
        source: candidate.source, sourceId: candidate.sourceId, name: candidate.title, employer: 'Example', area: 'Remote',
        salary: null, experience: { kind: 'unspecified' }, employment: 'full-time', schedule: 'flexible',
        workFormat: 'remote', description: 'A complete deterministic vacancy description.', keySkills: ['TypeScript'],
        url: candidate.url, publishedAt: candidate.publishedAt, sourceQuery: candidate.searchName,
      });
    },
  };
}

function context(deps: SourceHttpDependencies, writes: VacancyCandidateInput[], budget = 5): SourceContext {
  const policy = createSourceUrlPolicy([{ id: 'api', hosts: ['api.example.test'] }]);
  return {
    limits: { searchNewVacancyLimit: 20, searchPageBudgetPerPlatform: budget },
    trace() {}, errorMessage: String,
    recordListingCandidate: async (input) => { writes.push(input); return true; },
    http: createSourceHttp(policy, deps),
  };
}

function candidate(id: string): VacancyCandidate {
  return {
    source: parseSourceKey('api'), sourceId: parseSourceVacancyId(id),
    url: new URL(`https://api.example.test/jobs/${id}`), searchName: 'Backend', title: `Job ${id}`,
    summary: '', publishedAt: new Date('2026-01-01T00:00:00Z'), listingHash: parseVacancyListingHash('a'.repeat(64)),
    status: 'normalizing', attempts: 1, combinedScore: null,
  };
}

const publicLookup = async () => [{ address: '93.184.216.34' }];

test('API driver divides page budget, follows unique cursors, and preserves request options', async () => {
  const writes: VacancyCandidateInput[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const counts = new Map<string, number>();
  const deps: SourceHttpDependencies = {
    lookup: publicLookup,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const query = new URL(url).searchParams.get('q')!;
      const count = (counts.get(query) ?? 0) + 1; counts.set(query, count);
      return new Response(JSON.stringify({
        listings: [{ sourceId: `${query}-${count}`, url: `https://api.example.test/jobs/${query}-${count}`, title: `Job ${query}` }],
        nextCursor: count < 4 ? `page-${count + 1}` : undefined,
      }), { headers: { 'content-type': 'application/json' } });
    },
  };
  const source = createApiSource(definition(), { maxPages: 4 });
  const plan = { searches: [
    { search: { name: 'A', text: 'alpha' } satisfies Search, recipients: [{ userId: parseUserId('1'), searchName: 'A' }] },
    { search: { name: 'B', text: 'beta' } satisfies Search, recipients: [{ userId: parseUserId('2'), searchName: 'B' }] },
  ] };
  const result = await source.discover(plan, context(deps, writes, 5));
  assert.deepEqual([...counts], [['alpha', 3], ['beta', 2]]);
  assert.equal(result.searches, 2); assert.equal(result.users, 2); assert.equal(result.discovered, 5);
  assert.equal(writes.length, 5);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(calls[0]!.init.method, 'POST'); assert.equal(calls[0]!.init.body, '{}');
  assert.equal(headers.get('x-provider'), 'listing'); assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('user-agent'), 'JobseekerVacancyMonitor/1.0');
});

test('API cursor cycles stop and zero page allocation skips excess planned searches', async () => {
  const writes: VacancyCandidateInput[] = [];
  let calls = 0;
  const deps: SourceHttpDependencies = {
    lookup: publicLookup,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ listings: [], nextCursor: 'same' }),
        { headers: { 'content-type': 'application/json' } });
    },
  };
  const source = createApiSource(definition());
  await source.discover({ searches: [
    { search: { name: 'A', text: 'a' }, recipients: [] },
    { search: { name: 'B', text: 'b' }, recipients: [] },
  ] }, context(deps, writes, 1));
  assert.equal(calls, 1);
});

test('API normalization fetches detail independently and preserves null and Error results', async () => {
  const writes: VacancyCandidateInput[] = [];
  const details: string[] = [];
  const deps: SourceHttpDependencies = {
    lookup: publicLookup,
    fetch: async (url, init) => {
      details.push(url);
      assert.equal(init.method, 'GET');
      assert.equal(new Headers(init.headers).get('x-provider'), 'detail');
      const id = url.split('/').at(-1);
      return new Response(JSON.stringify(id === 'closed' ? { closed: true } : id === 'fail' ? { fail: true } : {}),
        { headers: { 'content-type': 'application/json' } });
    },
  };
  const source = createApiSource(definition());
  const result = await source.normalize([candidate('ok'), candidate('closed'), candidate('fail')], context(deps, writes));
  assert.equal(result.get('ok')?.constructor, Object);
  assert.equal(result.get('closed'), null);
  assert.match((result.get('fail') as Error).message, /bad detail/u);
  assert.equal(details.length, 3);
});
