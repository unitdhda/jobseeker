/**
 * First-party career sites run by large companies. The runner is deliberately data-driven: a new company supplies
 * its hosts, search-page codec, and detail-page codec while pagination, collection, profile validation, budgets,
 * observability, URL checks, and VacancyPlatform wiring remain shared.
 */
import * as v from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import { errorMessage, sourcesSettings, trace } from './config.ts';
import type { SearchPlan, SearchPlatform } from './contract.ts';
import {
  asObject, fetchSourceHtml, fetchSourceJson, hashedVacancy, htmlText, plainText, safeVacancyUrl, sourceUserAgent,
  VacancySearchCollector, type JsonObject,
} from './http.ts';

export type CompanySiteId = 'yandex';

export interface CompanyListing {
  sourceId: string;
  url: string;
  title: string;
  summary: string;
  employer: string;
  area: string;
  experience: string;
  employment: string;
  workFormat: string;
  keySkills: string[];
}

export interface CompanyListingPage { listings: CompanyListing[]; nextCursor?: string }

/** A site definition contains only the behavior that really differs between company career portals. */
export interface CompanySite {
  id: CompanySiteId;
  name: string;
  employer: string;
  hosts: readonly string[];
  queryLanguage: string;
  searchUrl(query: string, cursor?: string): string;
  listingPage(payload: unknown): CompanyListingPage;
  vacancy(site: CompanySite, candidate: VacancyCandidate, html: string, resolvedUrl: string): VacancyInput | null;
  rules?: readonly string[];
}

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const companySearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});
export type CompanySearchProfile = v.InferOutput<typeof companySearchProfileSchema>;
export type CompanySearch = CompanySearchProfile['searches'][number];

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

/** Generic server-rendered detail extraction used by company definitions without schema.org JobPosting. */
export function mainVacancyText(html: string): { title: string; description: string } | null {
  const titleMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  const title = htmlText(titleMatch?.[1] ?? '');
  const description = htmlText(mainMatch?.[1] ?? '');
  return title && description.length >= 20 ? { title, description } : null;
}

export function companyVacancyInput(site: CompanySite, candidate: VacancyCandidate, html: string,
  resolvedUrl = candidate.url): VacancyInput | null {
  const detail = mainVacancyText(html);
  const listing = candidate.payload as unknown as CompanyListing | null;
  if (!detail || !listing?.title) return null;
  const experience = listing.experience || detail.description.match(/от\s+\d+\s+лет/iu)?.[0] || '';
  return hashedVacancy({
    source: site.id,
    sourceId: candidate.sourceId,
    name: detail.title,
    employer: listing.employer || site.employer,
    area: listing.area || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience,
    employment: listing.employment,
    schedule: '',
    workFormat: listing.workFormat,
    description: detail.description,
    keySkills: listing.keySkills,
    url: safeVacancyUrl(site.id, resolvedUrl),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

export const companySites: Record<CompanySiteId, CompanySite> = {
  yandex: {
    id: 'yandex',
    name: 'Yandex Careers',
    employer: 'Яндекс',
    hosts: ['yandex.ru'],
    queryLanguage: 'Russian or an established technical title used in Russian vacancies',
    searchUrl: yandexSearchUrl,
    listingPage: yandexListingPage,
    vacancy(site, candidate, html, resolvedUrl) { return companyVacancyInput(site, candidate, html, resolvedUrl); },
    rules: ['Use Russian titles where possible; keep established English technical titles as separate searches.'],
  },
};

export function companyPlatform(id: CompanySiteId): SearchPlatform<typeof companySearchProfileSchema> {
  const site = companySites[id];
  return {
    id, name: site.name, hosts: site.hosts, schema: companySearchProfileSchema,
    template: () => ({
      platform: id,
      version: 1,
      purpose: `Public first-party vacancy search operated by ${site.employer}.`,
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }] },
      capabilities: {
        query: `One concise role title in ${site.queryLanguage}`,
        maxSearches: 8,
      },
      rules: [
        'Each query contains one role title without boolean syntax, slashes, pipes, or parentheses.',
        'Put translations and alternative titles in separate searches.',
        'Do not add adjacent occupations, generic industries, location, salary, or work-format terms.',
        ...(site.rules ?? []),
      ],
    }),
  };
}

export async function scrapeCompanySite(id: CompanySiteId,
  plan: SearchPlan<CompanySearch>): Promise<{ seen: number; discovered: number }> {
  const site = companySites[id];
  const collector = new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  const pagesPerSearch = Math.max(1, Math.min(sourcesSettings().additionalMaxPages,
    Math.floor(sourcesSettings().searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
  searches: for (const { search, recipients } of plan.searches) {
    let cursor: string | undefined;
    for (let page = 1; page <= pagesPerSearch; page++) {
      const url = site.searchUrl(search.query, cursor);
      try {
        trace('scrape.search.request', { platform: id, search: search.name, query: search.query, page, url });
        const result = site.listingPage(await fetchSourceJson(id, url, {
          headers: { accept: 'application/json', 'user-agent': sourceUserAgent },
          signal: AbortSignal.timeout(45_000),
        }));
        trace('scrape.search.result', { platform: id, search: search.name, page, found: result.listings.length });
        for (const listing of result.listings) {
          await collector.record({
            source: id,
            sourceId: listing.sourceId,
            url: safeVacancyUrl(id, listing.url),
            searchName: search.name,
            title: listing.title,
            summary: listing.summary.slice(0, 1_000),
            payload: listing as unknown as JsonObject,
          }, recipients);
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        cursor = result.nextCursor;
        if (!cursor) break;
      } catch (error) {
        console.error(`Failed to read ${site.name} search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function normalizeCompanyCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  const site = companySites[candidate.source as CompanySiteId];
  if (!site) throw new Error(`Unsupported company source: ${candidate.source}`);
  const page = await fetchSourceHtml(site.id, candidate.url);
  return site.vacancy(site, candidate, page.html, page.url);
}
