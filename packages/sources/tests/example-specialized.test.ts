import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import * as sources from '../src/index.ts';
import * as api from '../src/drivers/api.ts';
import * as ats from '../src/drivers/ats.ts';
import * as companySite from '../src/drivers/company-site.ts';
import * as jsonLdBoard from '../src/drivers/jsonld-board.ts';
import { hireHiListingUrls, hireHiSearchProfileSchema, hireHiSearchUrl, hireHiSource, hireHiVacancyPosting } from '../examples/hirehi.ts';
import { kasperskyEntries, kasperskyFlightNames, kasperskySearchUrl, kasperskySource } from '../examples/kaspersky.ts';
import { tbankListings, tbankRequestBody, tbankSource, tbankVacancyFromHtml } from '../examples/tbank.ts';
import { vkListingPage, vkSearchUrl, vkSource, vkVacancyText } from '../examples/vk.ts';
import { yandexListingPage, yandexSearchUrl, yandexSource } from '../examples/yandex.ts';
import { exampleSources } from '../examples/index.ts';
import { exampleSourceIds } from '../examples/catalogue.ts';
import { initToolkit, type SourceExtensionApi } from '../examples/toolkit.ts';

const extensionApi: SourceExtensionApi = { registerSourceProvider() {}, env: {},
  sources: Object.assign({}, sources, { drivers: { api, ats, companySite, jsonLdBoard } }) };
initToolkit(extensionApi);

test('specialized provider factories are fresh and their profile caps match templates', () => {
  const factories = [hireHiSource, yandexSource, vkSource, kasperskySource, tbankSource];
  const providers = factories.map((factory) => factory());
  assert.deepEqual(providers.map((provider) => provider.id), ['hirehi', 'yandex', 'vk', 'kaspersky', 'tbank']);
  for (const [index, factory] of factories.entries()) {
    assert.notEqual(factory(), providers[index]); assert.ok(providers[index]!.hosts.length > 0);
    assert.equal(providers[index]!.template().capabilities.maxSearches, 8);
  }
  const valid = { version: 1, searches: Array.from({ length: 8 }, (_, index) => ({
    name: `Role ${index}`, rationale: 'Direct CV evidence', query: `Developer ${index}`, specialization: 'development',
  })) };
  assert.equal(v.safeParse(hireHiSearchProfileSchema, valid).success, true);
  assert.equal(v.safeParse(hireHiSearchProfileSchema, { ...valid, searches: [...valid.searches, valid.searches[0]] }).success, false);
});

test('HireHi facet URL and listing/detail codecs remain constrained and canonical', () => {
  const url = hireHiSearchUrl({ name: 'Backend', rationale: 'Evidence', query: 'typescript', specialization: 'development' }, 2);
  assert.equal(url, 'https://hirehi.ru/vacancies/development?query=typescript&page=2');
  const listings = hireHiListingUrls('<a href="/vacancies/development/123"><b>Backend Engineer</b></a>');
  assert.equal(listings.get('123')?.title, 'Backend Engineer');
  const posting = hireHiVacancyPosting(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Backend Engineer', description: 'Complete vacancy description.', datePosted: '2026-01-01',
  })}</script>`, 'Backend Engineer');
  assert.equal(posting?.title, 'Backend Engineer');
});

test('Yandex and VK listing/detail codecs preserve canonical metadata', () => {
  assert.match(yandexSearchUrl('backend', 'next'), /^https:\/\/yandex\.ru\/jobs\/api/u);
  const yandex = yandexListingPage({ items: [{ id: '1', title: 'Backend', location: 'Moscow', publishedAt: '2026-01-02' }], next: '?cursor=two' });
  assert.equal(yandex.listings[0]?.url, 'https://yandex.ru/jobs/vacancies/1'); assert.equal(yandex.nextCursor, 'two');
  assert.match(vkSearchUrl('backend', '20'), /^https:\/\/team\.vk\.company\/career\/api/u);
  const vk = vkListingPage({ results: [{ id: '2', title: 'Backend', city: 'Remote', published_at: '2026-01-02' }], next: '?offset=40' });
  assert.equal(vk.listings[0]?.url, 'https://team.vk.company/vacancy/2'); assert.equal(vk.nextCursor, '40');
  assert.deepEqual(vkVacancyText('<h1 itemprop="title">Backend</h1><div itemprop="description">Build reliable production systems with TypeScript.</div>'),
    { title: 'Backend', description: 'Build reliable production systems with TypeScript.' });
});

test('Kaspersky parses server-rendered entries and inert metadata scripts', () => {
  assert.match(kasperskySearchUrl('backend'), /^https:\/\/careers\.kaspersky\.ru\/vacancies/u);
  assert.deepEqual(kasperskyEntries('<a href="/vacancies/backend-1"><span>Backend Engineer</span></a>'), [
    { sourceId: 'backend-1', url: 'https://careers.kaspersky.ru/vacancies/backend-1', title: 'Backend Engineer' },
  ]);
  assert.deepEqual(kasperskyFlightNames('<script>{"cities":["Moscow","Remote"],"skills":["TypeScript"]}</script>', 'cities'),
    ['Moscow', 'Remote']);
});

test('T-Bank RPC and SSR codecs validate inputs without executing embedded script', () => {
  assert.deepEqual(JSON.parse(tbankRequestBody('it', 'technology', 50)), {
    operationName: 'CareerVacancies', variables: { category: 'it', group: 'technology', offset: 50, limit: 50 },
  });
  assert.throws(() => tbankRequestBody('../bad', 'technology', 0), /category/u);
  const listings = tbankListings({ data: { vacancies: { items: [{ id: '3', title: 'Backend', slug: 'backend', publishedAt: '2026-01-02' }] } } }, 'technology');
  assert.equal(listings[0]?.url, 'https://www.tbank.ru/career/technology/vacancies/backend');
  const state = tbankVacancyFromHtml(`<script type="application/json">${JSON.stringify({ props: { vacancy: {
    title: 'Backend', description: 'Build reliable production systems.', location: 'Moscow',
  } } })}</script><script>throw new Error('must not execute')</script>`);
  assert.equal(state?.title, 'Backend');
});

test('full catalogue constructs exactly the manifest IDs with fresh instances and closed hosts', () => {
  const first = exampleSources(); const second = exampleSources();
  assert.deepEqual(first.map((provider) => provider.id), exampleSourceIds);
  assert.equal(new Set(first.map((provider) => provider.id)).size, 19);
  for (let index = 0; index < first.length; index += 1) {
    assert.notEqual(first[index], second[index]); assert.ok(first[index]!.hosts.length > 0);
    assert.equal(new Set(first[index]!.hosts).size, first[index]!.hosts.length);
  }
});
