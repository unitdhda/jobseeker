import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const mtsDefinition: JsonApiExampleDefinition = {
  id: 'mts', name: 'MTS Jobs', hosts: ['job.mts.ru'], language: 'Russian',
  searchUrl: (search, cursor) => `https://job.mts.ru/api/vacancies?search=${encodeURIComponent(search.query)}&offset=${cursor ?? '0'}`,
  listingPage(payload, _search, cursor) {
    const items = arrayAt(payload, 'results'); const offset = Number(cursor ?? 0);
    return { listings: items.map((item) => listing(textAt(item, 'slug') || textAt(item, 'id'),
      `https://job.mts.ru/vacancy/${textAt(item, 'slug') || textAt(item, 'id')}`, textAt(item, 'title'),
      { summary: textAt(item, 'shortDescription'), publishedAt: dateAt(item, 'publishedAt') })),
      ...(items.length ? { nextCursor: String(offset + items.length) } : {}) };
  },
  detailUrl: (candidate) => `https://job.mts.ru/api/vacancies/${candidate.sourceId}`,
  fields: (candidate, payload) => ({ name: textAt(payload, 'title') || candidate.title, employer: 'МТС',
    area: textAt(payload, 'city'), description: textAt(payload, 'description'), skills: stringArray(payload && (payload as Record<string, unknown>).skills),
    remote: /remote|удален/iu.test(textAt(payload, 'workFormat')), closed: Boolean(textAt(payload, 'archivedAt')),
    publishedAt: dateAt(payload, 'publishedAt') }),
};
export function mtsSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(mtsDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(mtsSource({ maxPages: examplePages(api) })); }
