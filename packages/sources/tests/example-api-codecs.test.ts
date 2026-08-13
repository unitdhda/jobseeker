import assert from 'node:assert/strict';
import test from 'node:test';
import * as sources from '../src/index.ts';
import * as api from '../src/drivers/api.ts';
import * as ats from '../src/drivers/ats.ts';
import * as companySite from '../src/drivers/company-site.ts';
import * as jsonLdBoard from '../src/drivers/jsonld-board.ts';
import { magnitDefinition, magnitSource } from '../examples/magnit.ts';
import { mtsDefinition, mtsSource } from '../examples/mts.ts';
import { ozonDefinition, ozonSource } from '../examples/ozon.ts';
import { rwbDefinition, rwbSource } from '../examples/rwb.ts';
import { sberDefinition, sberSource } from '../examples/sber.ts';
import { selectelDefinition, selectelSource } from '../examples/selectel.ts';
import { trudvsemRegion, trudvsemSource } from '../examples/trudvsem.ts';
import { yadroDefinition, yadroSource } from '../examples/yadro.ts';
import { initToolkit, type SourceExtensionApi } from '../examples/toolkit.ts';
import { parseSourceKey, parseSourceVacancyId, parseVacancyListingHash, type VacancyCandidate } from '@jobseeker/engine/contracts';

const extensionApi: SourceExtensionApi = {
  registerSourceProvider() {}, env: {},
  sources: Object.assign({}, sources, { drivers: { api, ats, companySite, jsonLdBoard } }),
};
initToolkit(extensionApi);

const search = { name: 'Backend', rationale: 'Direct CV evidence', query: 'backend' };
function candidate(source: string, id: string, title = 'Backend Engineer'): VacancyCandidate {
  return { source: parseSourceKey(source), sourceId: parseSourceVacancyId(id), url: new URL(`https://${source}.example.test/${id}`),
    searchName: 'Backend', title, summary: '', publishedAt: new Date('2026-01-01'),
    listingHash: parseVacancyListingHash('a'.repeat(64)), status: 'normalizing', attempts: 1, combinedScore: null };
}

test('JSON API example factories are fresh, uniquely identified, and declare canonical hosts', () => {
  const factories = [ozonSource, rwbSource, mtsSource, magnitSource, yadroSource, selectelSource, sberSource, trudvsemSource];
  const providers = factories.map((factory) => factory());
  assert.deepEqual(providers.map((provider) => provider.id), ['ozon', 'rwb', 'mts', 'magnit', 'yadro', 'selectel', 'sber', 'trudvsem']);
  for (const [index, factory] of factories.entries()) {
    assert.notEqual(factory(), providers[index]); assert.ok(providers[index]!.hosts.length > 0);
    assert.equal(providers[index]!.template().capabilities.maxSearches, 8);
  }
  assert.deepEqual(trudvsemSource().hosts, ['opendata.trudvsem.ru', 'trudvsem.ru']);
});

test('paginated listing codecs preserve IDs, titles, dates, canonical URLs, and cursor progress', () => {
  const cases = [
    [ozonDefinition, { items: [{ id: '1', title: 'Ozon Backend', summary: 'Summary', publishedAt: '2026-01-02' }] }],
    [rwbDefinition, { data: { items: [{ id: '2', name: 'RWB Backend', description: 'Summary', publishedAt: '2026-01-02' }] } }],
    [mtsDefinition, { results: [{ slug: 'mts-3', title: 'MTS Backend', shortDescription: 'Summary', publishedAt: '2026-01-02' }] }],
    [magnitDefinition, { vacancies: [{ id: '4', name: 'Magnit Backend', preview: 'Summary', createdAt: '2026-01-02' }] }],
    [sberDefinition, { data: [{ id: '5', title: 'Sber Backend', shortDescription: 'Summary', publishedAt: '2026-01-02' }] }],
  ] as const;
  for (const [definition, payload] of cases) {
    const page = definition.listingPage(payload, search, definition.id === 'mts' || definition.id === 'sber' ? '0' : '1');
    assert.equal(page.listings.length, 1, definition.id);
    assert.ok(page.listings[0]!.sourceId, definition.id); assert.ok(page.listings[0]!.title, definition.id);
    assert.equal(page.listings[0]!.publishedAt, '2026-01-02T00:00:00.000Z', definition.id);
    assert.match(page.listings[0]!.url, /^https:\/\//u, definition.id);
    assert.ok(page.nextCursor, definition.id);
  }
});

test('complete catalogue codecs retain payload and locally filter Selectel enumeration', () => {
  const yadro = yadroDefinition.listingPage({ items: [{ id: '6', title: 'Yadro Backend', description: 'A complete description.', publishedAt: '2026-01-02' }] }, search);
  assert.equal(yadro.listings[0]!.payload && typeof yadro.listings[0]!.payload, 'object');
  const selectel = selectelDefinition.listingPage({ vacancies: [
    { slug: 'backend', title: 'Senior Backend Engineer', description: 'Description' },
    { slug: 'design', title: 'Product Designer', description: 'Description' },
  ] }, search);
  assert.deepEqual(selectel.listings.map((item) => item.sourceId), ['backend']);
});

test('detail field codecs distinguish closed payloads and retain publication metadata', () => {
  const cases = [
    [ozonDefinition, candidate('ozon', '1'), { title: 'Backend', description: 'Build reliable TypeScript services for production.', status: 'closed', publishedAt: '2026-01-02' }],
    [rwbDefinition, candidate('rwb', '2'), { data: { name: 'Backend', description: 'Build reliable TypeScript services for production.', status: 'active', publishedAt: '2026-01-02' } }],
    [mtsDefinition, candidate('mts', '3'), { title: 'Backend', description: 'Build reliable TypeScript services for production.', publishedAt: '2026-01-02' }],
    [magnitDefinition, candidate('magnit', '4'), { name: 'Backend', description: 'Build reliable TypeScript services for production.', createdAt: '2026-01-02' }],
    [sberDefinition, candidate('sber', '5'), { title: 'Backend', markdown: 'Build reliable TypeScript services for production.', publishedAt: '2026-01-02' }],
  ] as const;
  for (const [definition, item, payload] of cases) {
    const fields = definition.fields(item, payload);
    assert.ok(fields.name); assert.equal(fields.publishedAt, '2026-01-02T00:00:00.000Z');
  }
  assert.equal(ozonDefinition.fields(cases[0][1], cases[0][2]).closed, true);
});

test('federal region validation is bounded and canonical', () => {
  assert.equal(trudvsemRegion(), '7700000000'); assert.equal(trudvsemRegion(' 7800000000 '), '7800000000');
  for (const value of ['77', 'abcdefghij', '77000000000']) assert.throws(() => trudvsemRegion(value), /region code/u);
});
