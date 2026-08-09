import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import type { CompanyListing, CompanyListingPage, CompanySite } from '@jobseeker/sources/drivers/company-site';
import { asObject, createCompanySiteSource, examplePages, hashedVacancy, htmlText, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const employer = 'VK';
const pageSize = 20;

/** Pagination is rebuilt on the approved public origin; the API's `next` field carries an http:// URL. */
export function vkCursor(next: unknown): string | undefined {
  if (typeof next !== 'string' || !next) return undefined;
  try { return new URL(next, 'https://team.vk.company').searchParams.get('offset') || undefined; }
  catch { return undefined; }
}

export function vkSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/career/api/v2/vacancies/', 'https://team.vk.company');
  // Only `title` filters the board; `search` and `query` are ignored and would return the whole catalogue.
  url.searchParams.set('title', query);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', cursor ?? '0');
  return url.toString();
}

function names(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.name)).filter(Boolean);
}

export function vkListingPage(payload: unknown): CompanyListingPage {
  const page = asObject(payload);
  const results = Array.isArray(page?.results) ? page.results : [];
  const listings = results.flatMap((value): CompanyListing[] => {
    const item = asObject(value);
    const sourceId = plainText(item?.id), title = plainText(item?.title);
    if (!/^\d+$/.test(sourceId) || !title) return [];
    const area = plainText(asObject(item?.town)?.name);
    const workFormat = [plainText(item?.work_format), item?.remote === true ? 'Удалённо' : '']
      .filter(Boolean).join(', ');
    return [{
      sourceId,
      url: `https://team.vk.company/vacancy/${sourceId}/`,
      title,
      summary: [plainText(asObject(item?.group)?.name), plainText(asObject(item?.prof_area)?.name),
        plainText(asObject(item?.specialty)?.name), area, workFormat].filter(Boolean).join(' · '),
      employer,
      area,
      experience: '',
      employment: '',
      workFormat,
      keySkills: names(item?.tags).slice(0, 30),
    }];
  });
  return { listings, nextCursor: vkCursor(page?.next) };
}

/** VK renders a vacancy as a titled `itemprop` block rather than schema.org JobPosting or a `<main>` element. */
export function vkVacancyText(html: string): { title: string; description: string } | null {
  const title = htmlText(/<div[^>]+itemprop="title"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
    ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  const article = /<div class="article" itemprop="description">([\s\S]*?)<\/div>\s*<div class="page-control">/i
    .exec(html)?.[1] ?? /<div class="article" itemprop="description">([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? '';
  const description = htmlText(article);
  return title && description.length >= 20 ? { title, description } : null;
}

export function vkVacancyInput(candidate: VacancyCandidate, html: string, resolvedUrl: string,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = vkVacancyText(html);
  const listing = candidate.payload as unknown as CompanyListing | null;
  if (!detail) return null;
  return hashedVacancy({
    source: 'vk',
    sourceId: candidate.sourceId,
    name: detail.title,
    employer: listing?.employer || employer,
    area: listing?.area || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience: listing?.experience || '',
    employment: listing?.employment || '',
    schedule: '',
    workFormat: listing?.workFormat || '',
    description: detail.description,
    keySkills: listing?.keySkills ?? [],
    url: validateUrl('vk', resolvedUrl),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

export const vkCompanySite: CompanySite = {
  id: 'vk',
  name: 'VK Careers',
  employer,
  hosts: ['team.vk.company'],
  queryLanguage: 'Russian, or an established English technical title used in Russian vacancies',
  searchUrl: vkSearchUrl,
  listingPage: vkListingPage,
  vacancy(_site, candidate, html, resolvedUrl, context) {
    return vkVacancyInput(candidate, html, resolvedUrl, context.http.safeVacancyUrl);
  },
  rules: [
    'The board matches the title substring, so keep queries to one short role title.',
    'Use Russian titles where possible and keep established English technical titles as separate searches.',
  ],
};

/** Fresh VK provider; register it in any createSources() collection. */
export function vkSource(options: { maxPages?: number } = {}) {
  return createCompanySiteSource(vkCompanySite, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(vkSource({ maxPages: examplePages(api) }));
}
