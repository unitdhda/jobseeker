
import type { CompanyListing, CompanyListingPage, CompanySite } from '@jobseeker/sources/drivers/company-site';
import { asObject, companyVacancyInput, createCompanySiteSource, examplePages, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

function objectNames(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.name)).filter(Boolean);
}

/** Rebuild pagination on the approved public origin; Yandex's API exposes an internal host in its `next` field. */
export function yandexCursor(next: unknown): string | undefined {
  if (typeof next !== 'string' || !next) return undefined;
  try { return new URL(next, 'https://yandex.ru').searchParams.get('cursor') || undefined; }
  catch { return undefined; }
}

export function yandexSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/jobs/api/jobs/publications', 'https://yandex.ru');
  url.searchParams.set('page_size', '20');
  url.searchParams.set('text', query);
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

export function yandexListingPage(payload: unknown): CompanyListingPage {
  const page = asObject(payload);
  const results = Array.isArray(page?.results) ? page.results : [];
  const listings = results.flatMap((value): CompanyListing[] => {
    const item = asObject(value);
    const vacancy = asObject(item?.vacancy);
    const id = plainText(item?.id), slug = plainText(item?.publication_slug_url), title = plainText(item?.title);
    // Redirect publications belong to another career site whose hosts and parser are not part of this definition.
    if (!id || !slug || !title || plainText(item?.redirect_url)) return [];
    return [{
      sourceId: id,
      url: `https://yandex.ru/jobs/vacancies/${encodeURIComponent(slug)}`,
      title,
      summary: plainText(item?.short_summary),
      employer: 'Яндекс',
      area: objectNames(vacancy?.cities).join(', '),
      experience: '',
      employment: plainText(vacancy?.employment_types),
      workFormat: objectNames(vacancy?.work_modes).join(', '),
      keySkills: objectNames(vacancy?.skills).slice(0, 30),
    }];
  });
  return { listings, nextCursor: yandexCursor(page?.next) };
}

export const yandexCompanySite: CompanySite = {
  id: 'yandex',
  name: 'Yandex Careers',
  employer: 'Яндекс',
  hosts: ['yandex.ru'],
  queryLanguage: 'Russian or an established technical title used in Russian vacancies',
  searchUrl: yandexSearchUrl,
  listingPage: yandexListingPage,
  vacancy(site, candidate, html, resolvedUrl, context) {
    return companyVacancyInput(site, candidate, html, resolvedUrl, context.http.safeVacancyUrl);
  },
  rules: ['Use Russian titles where possible; keep established English technical titles as separate searches.'],
};

/** Fresh Yandex provider; register it in any createSources() collection. */
export function yandexSource(options: { maxPages?: number } = {}) {
  return createCompanySiteSource(yandexCompanySite, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(yandexSource({ maxPages: examplePages(api) }));
}
