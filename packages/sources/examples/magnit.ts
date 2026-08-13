import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const magnitDefinition: JsonApiExampleDefinition = {
  id: 'magnit', name: 'Магнит Работа', hosts: ['rabota.magnit.ru'], language: 'Russian',
  searchUrl: (search, cursor) => `https://rabota.magnit.ru/api/vacancies?text=${encodeURIComponent(search.query)}&page=${cursor ?? '1'}`,
  listingPage(payload, _search, cursor) {
    const items = arrayAt(payload, 'vacancies'); const page = Number(cursor ?? 1);
    return { listings: items.map((item) => listing(textAt(item, 'id'), `https://rabota.magnit.ru/vacancy/${textAt(item, 'id')}`,
      textAt(item, 'name'), { summary: textAt(item, 'preview'), publishedAt: dateAt(item, 'createdAt') })),
      ...(items.length ? { nextCursor: String(page + 1) } : {}) };
  },
  detailUrl: (candidate) => `https://rabota.magnit.ru/api/vacancies/${candidate.sourceId}`,
  fields: (candidate, payload) => ({ name: textAt(payload, 'name') || candidate.title, employer: 'Магнит',
    area: textAt(payload, 'city'), description: textAt(payload, 'description'), skills: stringArray(textAt(payload, 'requirements')),
    remote: /remote|удален/iu.test(textAt(payload, 'workFormat')), closed: textAt(payload, 'active') === 'false',
    publishedAt: dateAt(payload, 'createdAt') }),
};
export function magnitSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(magnitDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(magnitSource({ maxPages: examplePages(api) })); }
