import assert from 'node:assert/strict';
import test from 'node:test';
import type { VacancyCandidate } from '@jobseeker/engine/contracts';
import { createAtsSource, configuredBoards } from '@jobseeker/sources/drivers/ats';
import { createJsonLdBoardSource } from '@jobseeker/sources/drivers/jsonld-board';
import type { SourceContext } from '../src/context.ts';

test('a custom JSON-LD board needs no central board id registration', () => {
  const provider = createJsonLdBoardSource({
    id: 'example-board', name: 'Example Board', hosts: ['jobs.example.com'],
    listing: (page) => `https://jobs.example.com/vacancies?page=${page}`,
    entries: () => new Map(), rules: ['Use exact titles.'],
  });
  assert.equal(provider.id, 'example-board');
  assert.deepEqual(provider.hosts, ['jobs.example.com']);
});

test('generic ATS wrapper owns product codecs but not source identity or customer boards', async () => {
  assert.deepEqual(configuredBoards(['greenhouse:acme', 'lever:beta']), {
    greenhouse: ['acme'], lever: ['beta'], ashby: [], smartrecruiters: [],
  });
  const provider = createAtsSource({ id: 'example-ats', name: 'Example ATS' });
  assert.equal(provider.id, 'example-ats');
  assert.ok(provider.hosts.includes('api.lever.co'));
  const context = {
    limits: { searchNewVacancyLimit: 1, searchPageBudgetPerPlatform: 1 },
    trace: () => undefined, errorMessage: String, recordListingCandidate: async () => true,
  } as unknown as SourceContext;
  assert.deepEqual(await provider.discover({ searches: [] }, context),
    { searches: 0, users: 0, seen: 0, discovered: 0, discoveredBySearch: {} });

  const candidate: VacancyCandidate = {
    source: 'example-ats', sourceId: 'lever:acme:1', url: 'https://jobs.lever.co/acme/1',
    searchName: 'Backend', title: 'Backend Engineer', summary: '', publishedAt: '2026-08-06T10:00:00.000Z',
    payload: { sourceId: 'lever:acme:1', url: 'https://jobs.lever.co/acme/1', title: 'Backend Engineer',
      description: 'Build and operate reliable backend services.', employer: 'Acme', location: 'Remote',
      publishedAt: '2026-08-01T10:00:00.000Z', employment: 'Full-time', remote: true },
    listingHash: 'hash', status: 'normalizing', attempts: 1, combinedScore: null,
  };
  const result = await provider.normalize([candidate], context);
  const normalized = result.get(candidate.sourceId);
  if (!normalized || normalized instanceof Error) assert.fail('Expected a normalized ATS vacancy');
  assert.equal(normalized.source, 'example-ats');
});
