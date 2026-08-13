import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const ozonDefinition: JsonApiExampleDefinition = {
  id: 'ozon', name: 'Ozon Jobs', hosts: ['job.ozon.ru'], language: 'Russian or English',
  searchUrl: (search, cursor) => `https://job.ozon.ru/api/vacancies?query=${encodeURIComponent(search.query)}&page=${cursor ?? '1'}`,
  listingPage(payload, _search, cursor) {
    const items = arrayAt(payload, 'items'); const page = Number(cursor ?? 1);
    return { listings: items.map((item) => listing(textAt(item, 'id'), `https://job.ozon.ru/vacancy/${textAt(item, 'id')}`,
      textAt(item, 'title'), { summary: textAt(item, 'summary'), publishedAt: dateAt(item, 'publishedAt') })),
      ...(items.length ? { nextCursor: String(page + 1) } : {}) };
  },
  detailUrl: (candidate) => `https://job.ozon.ru/api/vacancies/${candidate.sourceId}`,
  fields: (candidate, payload) => ({ name: textAt(payload, 'title') || candidate.title,
    employer: 'Ozon', area: textAt(payload, 'location'), description: textAt(payload, 'description'),
    skills: stringArray(arrayAt(payload, 'skills').map((item) => textAt(item, 'name'))),
    remote: /remote|удален/iu.test(textAt(payload, 'workFormat')), closed: textAt(payload, 'status') === 'closed',
    publishedAt: dateAt(payload, 'publishedAt') }),
};
export function ozonSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(ozonDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(ozonSource({ maxPages: examplePages(api) })); }
