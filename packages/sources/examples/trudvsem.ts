import * as v from 'valibot';
import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { apiVacancy } from './api-example.ts';
import { assertToolkitInitialized, createApiSource, examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';
import { listing } from './json-api-example.ts';
import { textSearchTemplate } from './profile.ts';

export function trudvsemRegion(raw?: string): string {
  const value = raw?.trim() || '7700000000';
  if (!/^\d{10}$/u.test(value)) throw new TypeError('Invalid Работа России region code.');
  return value;
}
const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const trudvsemSearchProfileSchema = v.strictObject({ version: v.literal(1), searches: v.pipe(v.array(v.strictObject({
  name: label, rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)), query: label,
})), v.maxLength(8)) });
export function trudvsemSource(options: { readonly maxPages?: number; readonly region?: string } = {}) {
  assertToolkitInitialized(); const region = trudvsemRegion(options.region);
  return createApiSource({ id: 'trudvsem', name: 'Работа России', hosts: ['opendata.trudvsem.ru', 'trudvsem.ru'], schema: trudvsemSearchProfileSchema,
    template: () => textSearchTemplate('trudvsem', 'Работа России', 'Russian'), searchName: (search) => search.name,
    searchUrl: (search, cursor) => `https://opendata.trudvsem.ru/api/v1/vacancies/region/${region}?text=${encodeURIComponent(search.query)}&offset=${cursor ?? '0'}`,
    listingPage(payload, _search, cursor) { const items = arrayAt(payload, 'results', 'vacancies'); const offset = Number(cursor ?? 0);
      return { listings: items.map((wrapper) => { const item = (wrapper.vacancy as Record<string, unknown>) ?? wrapper;
        return listing(textAt(item, 'id'), `https://trudvsem.ru/vacancy/card/${textAt(item, 'id')}`, textAt(item, 'job-name'),
          { summary: textAt(item, 'duty'), publishedAt: dateAt(item, 'creation-date'), payload: item }); }),
        ...(items.length ? { nextCursor: String(offset + items.length) } : {}) }; },
    vacancy(candidate, payload) { return apiVacancy(candidate, { name: textAt(payload, 'job-name') || candidate.title,
      employer: textAt(payload, 'company', 'name'), area: textAt(payload, 'region', 'name'), description: textAt(payload, 'duty'),
      skills: stringArray(textAt(payload, 'requirement', 'qualification')), remote: /remote|удален/iu.test(textAt(payload, 'work-place')),
      closed: textAt(payload, 'vacancy-status') === 'closed', publishedAt: dateAt(payload, 'creation-date') }); }
  }, { maxPages: options.maxPages });
}
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(trudvsemSource({ maxPages: examplePages(api), region: api.env.TRUDVSEM_REGION })); }
