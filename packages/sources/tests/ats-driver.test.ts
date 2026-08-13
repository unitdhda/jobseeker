import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredBoards,
  createAtsSource,
  createSourceHttp,
  createSourceUrlPolicy,
  postingMatchesQuery,
  type SourceContext,
  type SourceHttpDependencies,
} from '../src/index.ts';
import {
  parseUserId,
  parseVacancyListingHash,
  type VacancyCandidateInput,
} from '@jobseeker/engine/contracts';

const publicLookup = async () => [{ address: '93.184.216.34' }];

function context(payloads: Readonly<Record<string, unknown>>, writes: VacancyCandidateInput[], calls: string[]): SourceContext {
  const hosts = ['boards-api.greenhouse.io', 'job-boards.greenhouse.io', 'api.lever.co', 'jobs.lever.co',
    'api.ashbyhq.com', 'jobs.ashbyhq.com', 'api.smartrecruiters.com', 'jobs.smartrecruiters.com'];
  const dependencies: SourceHttpDependencies = {
    lookup: publicLookup,
    fetch: async (url) => {
      calls.push(url);
      const payload = payloads[url];
      if (payload === undefined) throw new Error(`Unexpected URL ${url}`);
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    },
  };
  return {
    limits: { searchNewVacancyLimit: 20, searchPageBudgetPerPlatform: 20 }, trace() {}, errorMessage: String,
    recordListingCandidate: async (input) => { writes.push(input); return true; },
    http: createSourceHttp(createSourceUrlPolicy([{ id: 'ats', hosts }]), dependencies),
  };
}

test('ATS board declarations reject unknown/malformed entries and deduplicate slugs', () => {
  assert.deepEqual(configuredBoards(['greenhouse:acme', 'greenhouse:acme', 'lever:other']), {
    greenhouse: ['acme'], lever: ['other'], ashby: [], smartrecruiters: [],
  });
  for (const entry of ['unknown:acme', 'greenhouse:', 'greenhouse:a/b', 'greenhouse:a:b']) {
    assert.throws(() => configuredBoards([entry]), /Invalid ATS board declaration/u);
  }
});

test('ATS title matching requires every significant query word', () => {
  assert.equal(postingMatchesQuery('Senior Backend TypeScript Engineer', 'backend typescript'), true);
  assert.equal(postingMatchesQuery('Backend Engineer', 'backend typescript'), false);
  assert.equal(postingMatchesQuery('Backend Engineer', 'a'), false);
});

test('grouped ATS codecs produce canonical URLs and SmartRecruiters fetches detail only after title match', async () => {
  const writes: VacancyCandidateInput[] = [];
  const calls: string[] = [];
  const payloads = {
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true': { jobs: [{ id: 1, title: 'Backend Engineer',
      content: '<p>Build reliable backend systems with TypeScript.</p>', location: { name: 'Remote' }, updated_at: '2026-01-01' }] },
    'https://api.lever.co/v0/postings/acme?mode=json': [{ id: '2', text: 'Backend Engineer',
      descriptionPlain: 'Build reliable backend services with TypeScript.', categories: { location: 'Berlin', commitment: 'Full-time' }, createdAt: '2026-01-02' }],
    'https://api.ashbyhq.com/posting-api/job-board/acme': { jobs: [{ id: '3', title: 'Backend Engineer',
      descriptionPlain: 'Build reliable backend applications with TypeScript.', location: 'Remote', publishedAt: '2026-01-03', isRemote: true }] },
    'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100': { content: [
      { id: '4', name: 'Backend Engineer', releasedDate: '2026-01-04', location: { city: 'Paris', country: 'FR' } },
      { id: '5', name: 'Product Designer', releasedDate: '2026-01-04' },
    ] },
    'https://api.smartrecruiters.com/v1/companies/acme/postings/4': { jobAd: { sections: {
      jobDescription: { text: 'Build reliable backend products.' }, qualifications: { text: 'Strong TypeScript engineering.' },
    } } },
  } as const;
  const source = createAtsSource({ id: 'ats', name: 'ATS' }, {
    boards: ['greenhouse:acme', 'lever:acme', 'ashby:acme', 'smartrecruiters:acme'],
  });
  const result = await source.discover({ searches: [{
    search: { name: 'Backend', rationale: 'CV evidence', query: 'backend engineer' },
    recipients: [{ userId: parseUserId('1'), searchName: 'Backend' }],
  }] }, context(payloads, writes, calls));
  assert.equal(result.discovered, 4);
  assert.deepEqual(writes.map((item) => item.url.href), [
    'https://job-boards.greenhouse.io/acme/jobs/1', 'https://jobs.lever.co/acme/2',
    'https://jobs.ashbyhq.com/acme/3', 'https://jobs.smartrecruiters.com/acme/4',
  ]);
  assert.equal(calls.some((url) => url.endsWith('/postings/5')), false);
  const normalized = await source.normalize(writes.map((item, index) => ({
    ...item, summary: '', publishedAt: item.publishedAt ?? new Date(),
    listingHash: parseVacancyListingHash(index.toString(16).padStart(64, 'a')),
    status: 'normalizing' as const, attempts: 1, combinedScore: null,
  })), context(payloads, [], []));
  assert.equal([...normalized.values()].every((value) => value !== null && !(value instanceof Error)), true);
});
