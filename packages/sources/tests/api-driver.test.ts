import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import type { VacancyCandidate, VacancyCandidateInput } from '@jobseeker/engine/contracts';
import { createApiSource } from '../src/drivers/api.ts';
import type { SourceContext } from '../src/context.ts';

const schema = v.strictObject({
  version: v.literal(1),
  searches: v.array(v.strictObject({ name: v.string(), query: v.string() })),
});

function candidate(sourceId: string, payload: unknown): VacancyCandidate {
  return {
    source: 'example-api', sourceId, url: `https://api.example.com/jobs/${sourceId}`,
    searchName: 'Backend', title: `Job ${sourceId}`, summary: '', publishedAt: '2026-08-06T10:00:00.000Z',
    payload, listingHash: 'hash', status: 'normalizing', attempts: 1, combinedScore: null,
  };
}

test('generic API wrapper paginates listings, persists candidates, and fetches optional details', async () => {
  const recorded: VacancyCandidateInput[] = [];
  const requests: Array<{ url: string; headers: Headers }> = [];
  const context = {
    limits: { searchNewVacancyLimit: 10, searchPageBudgetPerPlatform: 2 },
    trace: () => undefined,
    errorMessage: String,
    recordListingCandidate: async (input: VacancyCandidateInput) => { recorded.push(input); return true; },
    http: {
      sourceUrl: (_source: string, input: string) => new URL(input),
      safeVacancyUrl: (_source: string, input: string) => new URL(input).toString(),
      fetchSourceJson: async (_source: string, url: string, init?: RequestInit) => {
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.endsWith('/detail/1')) return { detail: true };
        const page = new URL(url).searchParams.get('page') ?? '1';
        return page === '1'
          ? { items: [{ id: '1', title: 'Backend Engineer' }], next: '2' }
          : { items: [{ id: '2', title: 'Platform Engineer' }] };
      },
    },
  } as unknown as SourceContext;

  const provider = createApiSource({
    id: 'example-api', name: 'Example API', hosts: ['api.example.com'], schema,
    template: () => ({ platform: 'example-api', version: 1, purpose: 'Test.', jsonShape: {},
      capabilities: {}, rules: [] }),
    searchName: (search) => search.name,
    searchUrl(search, cursor) {
      const url = new URL('/jobs', 'https://api.example.com');
      url.searchParams.set('query', search.query);
      url.searchParams.set('page', cursor ?? '1');
      return url.toString();
    },
    listingPage(payload) {
      const page = payload as { items: Array<{ id: string; title: string }>; next?: string };
      return { listings: page.items.map((item) => ({ sourceId: item.id,
        url: `https://api.example.com/jobs/${item.id}`, title: item.title })), nextCursor: page.next };
    },
    detailUrl: (item) => `https://api.example.com/detail/${item.sourceId}`,
    vacancy: () => null,
    requestInit: (phase) => ({ headers: { 'x-api-phase': phase } }),
  }, { maxPages: 2 });

  const result = await provider.discover({ searches: [{
    search: { name: 'Backend', query: 'backend engineer' }, recipients: [{ userId: 'u1', searchName: 'Backend' }],
  }] }, context);
  assert.deepEqual(result, { searches: 1, users: 1, seen: 2, discovered: 2,
    discoveredBySearch: { Backend: 2 } });
  assert.deepEqual(recorded.map(({ sourceId, searchName }) => [sourceId, searchName]),
    [['1', 'Backend'], ['2', 'Backend']]);
  assert.equal(requests[0]!.headers.get('user-agent'), 'JobseekerVacancyMonitor/1.0');
  assert.equal(requests[0]!.headers.get('accept'), 'application/json');
  assert.equal(requests[0]!.headers.get('x-api-phase'), 'listing');

  const normalized = await provider.normalize([candidate('1', recorded[0]!.payload)], context);
  assert.equal(normalized.get('1'), null);
  assert.ok(requests.some(({ url, headers }) =>
    url.endsWith('/detail/1') && headers.get('x-api-phase') === 'detail'));
});
