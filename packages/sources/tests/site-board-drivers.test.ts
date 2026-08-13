import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCompanySiteSource,
  createJsonLdBoardSource,
  createSourceHttp,
  createSourceUrlPolicy,
  mainVacancyText,
  type CompanyListingPage,
  type CompanySite,
  type JsonLdBoard,
  type SourceContext,
  type SourceHttpDependencies,
} from '../src/index.ts';
import {
  parseSourceVacancyId,
  parseUserId,
  parseVacancyListingHash,
  type VacancyCandidate,
  type VacancyCandidateInput,
} from '@jobseeker/engine/contracts';

const publicLookup = async () => [{ address: '93.184.216.34' }];
function context(host: string, responses: Readonly<Record<string, { body: string; type: string }>>,
  writes: VacancyCandidateInput[], calls: string[], budget = 10): SourceContext {
  const dependencies: SourceHttpDependencies = {
    lookup: publicLookup,
    fetch: async (url) => {
      calls.push(url);
      const response = responses[url];
      if (!response) throw new Error(`Unexpected URL ${url}`);
      return new Response(response.body, { headers: { 'content-type': response.type } });
    },
  };
  return {
    limits: { searchNewVacancyLimit: 10, searchPageBudgetPerPlatform: budget }, trace() {}, errorMessage: String,
    recordListingCandidate: async (input) => { writes.push(input); return true; },
    http: createSourceHttp(createSourceUrlPolicy([{ id: 'site', hosts: [host] }]), dependencies),
  };
}
function candidate(input: VacancyCandidateInput): VacancyCandidate {
  return { ...input, summary: input.summary ?? '', publishedAt: input.publishedAt ?? new Date('2026-01-01'),
    listingHash: parseVacancyListingHash('a'.repeat(64)), status: 'normalizing', attempts: 1, combinedScore: null };
}

test('company-site driver paginates JSON listing and normalizes canonical h1/main detail', async () => {
  const writes: VacancyCandidateInput[] = []; const calls: string[] = [];
  const site: CompanySite = {
    id: 'site', name: 'Example Careers', employer: 'Example', hosts: ['careers.example.test'], queryLanguage: 'English',
    searchUrl: (query, cursor) => `https://careers.example.test/api?q=${query}&page=${cursor ?? '1'}`,
    listingPage: (payload) => {
      if (typeof payload !== 'object' || payload === null || !('listings' in payload)) throw new TypeError('Invalid test page.');
      return payload as CompanyListingPage;
    },
  };
  const listing = (id: string) => ({ sourceId: id, url: `https://careers.example.test/jobs/${id}`,
    title: 'Backend Engineer', summary: 'Build systems', employer: 'Example', area: 'Remote', experience: '2 years',
    employment: 'full-time', workFormat: 'remote', keySkills: ['TypeScript'], publishedAt: '2026-01-02' });
  const responses = {
    'https://careers.example.test/api?q=backend&page=1': { body: JSON.stringify({ listings: [listing('1')], nextCursor: '2' }), type: 'application/json' },
    'https://careers.example.test/api?q=backend&page=2': { body: JSON.stringify({ listings: [listing('2')] }), type: 'application/json' },
    'https://careers.example.test/jobs/1': { body: '<h1>Senior Backend Engineer</h1><main><p>Build reliable TypeScript services and maintain production systems.</p></main>', type: 'text/html' },
  };
  const source = createCompanySiteSource(site, { maxPages: 3 });
  const ctx = context('careers.example.test', responses, writes, calls);
  const result = await source.discover({ searches: [{ search: { name: 'Backend', rationale: 'CV evidence', query: 'backend' },
    recipients: [{ userId: parseUserId('1'), searchName: 'Backend' }] }] }, ctx);
  assert.equal(result.discovered, 2);
  assert.deepEqual(writes.map((item) => item.title), ['Backend Engineer', 'Backend Engineer']);
  const normalized = await source.normalize([candidate(writes[0]!)], ctx);
  const vacancy = normalized.get('1');
  assert.ok(vacancy && !(vacancy instanceof Error));
  assert.equal(vacancy.name, 'Senior Backend Engineer'); assert.equal(vacancy.workFormat, 'remote');
  assert.equal(vacancy.experience.kind, 'range');
});

test('generic company detail is conservative when h1 or meaningful main content is absent', () => {
  assert.equal(mainVacancyText('<main>Long enough vacancy description without a title.</main>'), null);
  assert.equal(mainVacancyText('<h1>Title</h1><main>short</main>'), null);
});

test('JSON-LD board enumerates pages once, retains listing title/date, and handles closed details', async () => {
  const writes: VacancyCandidateInput[] = []; const calls: string[] = [];
  const board: JsonLdBoard = {
    id: 'site', name: 'Board', hosts: ['board.example.test'], rules: ['Use English titles.'],
    listing: (page) => `https://board.example.test/jobs?page=${page}`,
    entries: (html) => new Map(JSON.parse(html) as [string, { url: string; title: string; publishedAt?: string }][]),
  };
  const entries = [[
    '1', { url: 'https://board.example.test/jobs/1', title: 'Backend TypeScript Engineer', publishedAt: '2026-01-03' },
  ], [
    '2', { url: 'https://board.example.test/jobs/2', title: 'Product Designer', publishedAt: '2026-01-04' },
  ]];
  const posting = { '@type': 'JobPosting', title: 'Backend TypeScript Engineer',
    description: '<p>Build reliable TypeScript backend services for production users.</p>', datePosted: '2026-01-03',
    hiringOrganization: { name: 'Example' }, jobLocation: { address: { addressLocality: 'Remote' } } };
  const responses = {
    'https://board.example.test/jobs?page=1': { body: JSON.stringify(entries), type: 'text/html' },
    'https://board.example.test/jobs?page=2': { body: '[]', type: 'text/html' },
    'https://board.example.test/jobs/1': { body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>`, type: 'text/html' },
    'https://board.example.test/jobs/closed': { body: '<h1>Closed</h1>', type: 'text/html' },
  };
  const source = createJsonLdBoardSource(board, { maxPages: 5 });
  const ctx = context('board.example.test', responses, writes, calls);
  const result = await source.discover({ searches: [{ search: { name: 'Backend', rationale: 'CV evidence', query: 'backend typescript' },
    recipients: [{ userId: parseUserId('1'), searchName: 'Backend' }] }] }, ctx);
  assert.equal(source.enumerates, true); assert.equal(result.discovered, 1); assert.equal(writes[0]?.title, 'Backend TypeScript Engineer');
  assert.equal(writes[0]?.publishedAt?.toISOString(), '2026-01-03T00:00:00.000Z');
  assert.deepEqual(calls.slice(0, 2), ['https://board.example.test/jobs?page=1', 'https://board.example.test/jobs?page=2']);
  const closedInput: VacancyCandidateInput = { ...writes[0]!,
    sourceId: parseSourceVacancyId('closed'),
    url: new URL('https://board.example.test/jobs/closed') };
  const normalized = await source.normalize([candidate(writes[0]!), candidate(closedInput)], ctx);
  assert.ok(normalized.get('1') && !(normalized.get('1') instanceof Error));
  assert.equal(normalized.get(closedInput.sourceId), null);
});
