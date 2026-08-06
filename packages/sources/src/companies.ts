/**
 * First-party career sites run by large companies. The runner is deliberately data-driven: a new company supplies
 * its hosts, search-page codec, and detail-page codec while pagination, collection, profile validation, budgets,
 * observability, URL checks, and VacancyPlatform wiring remain shared.
 */
import * as v from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { SourceContext } from './context.ts';
import type { SearchPlan, SearchPlatform } from './contract.ts';
import {
  hashedVacancy, htmlText, sourceUserAgent, VacancySearchCollector, type JsonObject,
} from './http.ts';
import { createSourceProvider, type SourceProvider } from './sources.ts';

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
  id: string;
  name: string;
  employer: string;
  hosts: readonly string[];
  queryLanguage: string;
  searchUrl(query: string, cursor?: string): string;
  listingPage(payload: unknown): CompanyListingPage;
  vacancy(site: CompanySite, candidate: VacancyCandidate, html: string, resolvedUrl: string,
    context: SourceContext): VacancyInput | null;
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

/** Generic server-rendered detail extraction used by company definitions without schema.org JobPosting. */
export function mainVacancyText(html: string): { title: string; description: string } | null {
  const titleMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  const title = htmlText(titleMatch?.[1] ?? '');
  const description = htmlText(mainMatch?.[1] ?? '');
  return title && description.length >= 20 ? { title, description } : null;
}

export function companyVacancyInput(site: CompanySite, candidate: VacancyCandidate, html: string,
  resolvedUrl: string,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
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
    url: validateUrl(site.id, resolvedUrl),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

export function companyPlatform(site: CompanySite): SearchPlatform<typeof companySearchProfileSchema> {
  return {
    id: site.id, name: site.name, hosts: site.hosts, schema: companySearchProfileSchema,
    template: () => ({
      platform: site.id,
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

export async function scrapeCompanySite(site: CompanySite, plan: SearchPlan<CompanySearch>, context: SourceContext,
  maxPages: number): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit,
    context.recordListingCandidate);
  const pagesPerSearch = Math.max(1, Math.min(maxPages,
    Math.floor(context.limits.searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
  searches: for (const { search, recipients } of plan.searches) {
    let cursor: string | undefined;
    for (let page = 1; page <= pagesPerSearch; page++) {
      const url = site.searchUrl(search.query, cursor);
      try {
        context.trace('scrape.search.request', { platform: site.id, page });
        const result = site.listingPage(await context.http.fetchSourceJson(site.id, url, {
          headers: { accept: 'application/json', 'user-agent': sourceUserAgent },
          signal: AbortSignal.timeout(45_000),
        }));
        context.trace('scrape.search.result', { platform: site.id, page, found: result.listings.length });
        for (const listing of result.listings) {
          await collector.record({
            source: site.id,
            sourceId: listing.sourceId,
            url: context.http.safeVacancyUrl(site.id, listing.url),
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
        console.error(`Failed to read ${site.name} search page ${page}: ${context.errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function normalizeCompanyCandidate(site: CompanySite, candidate: VacancyCandidate,
  context: SourceContext): Promise<VacancyInput | null> {
  if (candidate.source !== site.id) {
    throw new Error(`Company provider ${site.id} cannot normalize source ${candidate.source}.`);
  }
  const page = await context.http.fetchSourceHtml(site.id, candidate.url);
  return site.vacancy(site, candidate, page.html, page.url, context);
}

/** Builds a fresh first-party company provider without editing a central company-id union or site map. */
export function createCompanySiteSource(site: CompanySite,
  options: { maxPages?: number } = {}): SourceProvider<typeof companySearchProfileSchema> {
  const platform = companyPlatform(site);
  return createSourceProvider({
    ...platform,
    async discover(plan, context) {
      const result = await scrapeCompanySite(site, plan, context, options.maxPages ?? 1);
      const users = new Set(plan.searches.flatMap((search) =>
        search.recipients.map((recipient) => recipient.userId)));
      return { searches: plan.searches.length, users: users.size, ...result };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      for (const candidate of candidates) {
        try { results.set(candidate.sourceId, await normalizeCompanyCandidate(site, candidate, context)); }
        catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
      }
      return results;
    },
  });
}
