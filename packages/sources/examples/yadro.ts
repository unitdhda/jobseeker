import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { jsonApiExampleSource, listing, type JsonApiExampleDefinition } from './json-api-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const yadroDefinition: JsonApiExampleDefinition = {
  id: 'yadro', name: 'YADRO Careers', hosts: ['careers.yadro.com'], language: 'Russian or English',
  searchUrl: (search, cursor) => `https://careers.yadro.com/api/vacancies?query=${encodeURIComponent(search.query)}&page=${cursor ?? '1'}`,
  listingPage(payload) {
    const items = arrayAt(payload, 'items');
    return { listings: items.map((item) => listing(textAt(item, 'id'), `https://careers.yadro.com/vacancy/${textAt(item, 'id')}`,
      textAt(item, 'title'), { summary: textAt(item, 'description'), publishedAt: dateAt(item, 'publishedAt'), payload: item })) };
  },
  fields: (candidate, payload) => ({ name: textAt(payload, 'title') || candidate.title, employer: 'YADRO',
    area: textAt(payload, 'location'), description: textAt(payload, 'description'), skills: stringArray(payload && (payload as Record<string, unknown>).skills),
    remote: /remote|удален/iu.test(textAt(payload, 'format')), closed: textAt(payload, 'status') === 'closed',
    publishedAt: dateAt(payload, 'publishedAt') }),
};
export function yadroSource(options: { readonly maxPages?: number } = {}) { return jsonApiExampleSource(yadroDefinition, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(yadroSource({ maxPages: examplePages(api) })); }
