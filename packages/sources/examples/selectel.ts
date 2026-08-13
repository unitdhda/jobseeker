import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const selectelDefinition: JsonApiExampleDefinition = {
  id: 'selectel', name: 'Selectel Careers', hosts: ['careers.selectel.ru'], language: 'Russian',
  searchUrl: () => 'https://careers.selectel.ru/api/vacancies',
  listingPage(payload, search) {
    const words = search.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const items = arrayAt(payload, 'vacancies').filter((item) => words.every((word) => textAt(item, 'title').toLocaleLowerCase().includes(word)));
    return { listings: items.map((item) => listing(textAt(item, 'slug'), `https://careers.selectel.ru/vacancies/${textAt(item, 'slug')}`,
      textAt(item, 'title'), { summary: textAt(item, 'description'), publishedAt: dateAt(item, 'publishedAt'), payload: item })) };
  },
  fields: (candidate, payload) => ({ name: textAt(payload, 'title') || candidate.title, employer: 'Selectel',
    area: textAt(payload, 'location'), description: textAt(payload, 'description'), skills: stringArray(payload && (payload as Record<string, unknown>).skills),
    remote: /remote|удален/iu.test(textAt(payload, 'format')), closed: textAt(payload, 'active') === 'false',
    publishedAt: dateAt(payload, 'publishedAt') }),
};
export function selectelSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(selectelDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(selectelSource({ maxPages: examplePages(api) })); }
