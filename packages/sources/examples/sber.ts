import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const sberDefinition: JsonApiExampleDefinition = {
  id: 'sber', name: 'Сбер Карьера', hosts: ['career.sber.ru'], language: 'Russian',
  searchUrl: (search, cursor) => `https://career.sber.ru/api/vacancies?query=${encodeURIComponent(search.query)}&offset=${cursor ?? '0'}`,
  listingPage(payload, _search, cursor) {
    const items = arrayAt(payload, 'data'); const offset = Number(cursor ?? 0);
    return { listings: items.map((item) => listing(textAt(item, 'id'), `https://career.sber.ru/vacancy/${textAt(item, 'id')}`,
      textAt(item, 'title'), { summary: textAt(item, 'shortDescription'), publishedAt: dateAt(item, 'publishedAt'), payload: item })),
      ...(items.length ? { nextCursor: String(offset + items.length) } : {}) };
  },
  fields: (candidate, payload) => ({ name: textAt(payload, 'title') || candidate.title, employer: 'Сбер', area: textAt(payload, 'city'),
    description: textAt(payload, 'description') || textAt(payload, 'markdown'), skills: stringArray(payload && (payload as Record<string, unknown>).skills),
    remote: /remote|удален/iu.test(textAt(payload, 'format')), closed: textAt(payload, 'status') === 'closed', publishedAt: dateAt(payload, 'publishedAt') }),
};
export function sberSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(sberDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(sberSource({ maxPages: examplePages(api) })); }
