import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const rwbDefinition: JsonApiExampleDefinition = {
  id: 'rwb', name: 'RWB Careers', hosts: ['career.wb.ru'], language: 'Russian',
  searchUrl: (search, cursor) => `https://career.wb.ru/api/v1/vacancies?search=${encodeURIComponent(search.query)}&page=${cursor ?? '1'}`,
  listingPage(payload, _search, cursor) {
    const items = arrayAt(payload, 'data', 'items'); const page = Number(cursor ?? 1);
    return { listings: items.map((item) => listing(textAt(item, 'id'), `https://career.wb.ru/vacancies/${textAt(item, 'id')}`,
      textAt(item, 'name'), { summary: textAt(item, 'description'), publishedAt: dateAt(item, 'publishedAt') })),
      ...(items.length ? { nextCursor: String(page + 1) } : {}) };
  },
  detailUrl: (candidate) => `https://career.wb.ru/api/v1/vacancies/${candidate.sourceId}`,
  fields: (candidate, payload) => ({ name: textAt(payload, 'data', 'name') || candidate.title,
    employer: 'RWB', area: textAt(payload, 'data', 'city'), description: textAt(payload, 'data', 'description'),
    skills: stringArray(textAt(payload, 'data', 'requirements')), remote: /remote|удален/iu.test(textAt(payload, 'data', 'format')),
    closed: textAt(payload, 'data', 'status') === 'archived', publishedAt: dateAt(payload, 'data', 'publishedAt') }),
};
export function rwbSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(rwbDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(rwbSource({ maxPages: examplePages(api) })); }
