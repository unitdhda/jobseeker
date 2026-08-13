import * as v from 'valibot';
import {
  parseSourceKey,
  parseSourceVacancyId,
  type ExperienceRequirement,
  type VacancyCandidate,
  type VacancyInput,
  type WorkFormat,
} from '@jobseeker/engine/contracts';
import type { SearchPlan, SearchPlatform } from './contract.ts';
import type { SourceContext } from './context.ts';
import { hashedVacancy, htmlText, VacancySearchCollector } from './http.ts';
import { createSourceProvider, type SourceProvider } from './sources.ts';

export interface CompanyListing {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly summary: string;
  readonly employer: string;
  readonly area: string;
  readonly experience: string;
  readonly employment: string;
  readonly workFormat: string;
  readonly keySkills: readonly string[];
  readonly publishedAt?: string;
}

export interface CompanyListingPage {
  readonly listings: readonly CompanyListing[];
  readonly nextCursor?: string;
}

export interface CompanySite {
  readonly id: string;
  readonly name: string;
  readonly employer: string;
  readonly hosts: readonly string[];
  readonly queryLanguage: string;
  searchUrl(query: string, cursor?: string): string;
  listingPage(payload: unknown, cursor?: string): CompanyListingPage;
  vacancy?(site: CompanySite, candidate: VacancyCandidate, html: string, resolvedUrl: string,
    context: SourceContext): VacancyInput | null;
  readonly rules?: readonly string[];
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

export function mainVacancyText(html: string): { readonly title: string; readonly description: string } | null {
  const title = htmlText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu.exec(html)?.[1] ?? '');
  const description = htmlText(/<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(html)?.[1] ?? '');
  return title && description.length >= 20 ? Object.freeze({ title, description }) : null;
}

function experience(labelValue: string): ExperienceRequirement {
  if (!labelValue.trim()) return { kind: 'unspecified' };
  const years = /(?:от\s*)?(\d+(?:[.,]\d+)?)\s*(?:лет|года?|years?)/iu.exec(labelValue);
  return years
    ? { kind: 'range', minimumYears: Number(years[1]!.replace(',', '.')), maximumYears: null }
    : { kind: 'other', label: labelValue.trim() };
}

function workFormat(value: string): WorkFormat {
  const text = value.toLocaleLowerCase();
  if (/remote|удален/iu.test(text)) return 'remote';
  if (/hybrid|гибрид/iu.test(text)) return 'hybrid';
  if (/office|офис|on.?site/iu.test(text)) return 'on-site';
  return text ? 'other' : 'unspecified';
}

export function companyVacancyInput(
  site: CompanySite, candidate: VacancyCandidate, html: string, resolvedUrl: string,
  validateUrl: (source: string, input: string) => string,
): VacancyInput | null {
  const detail = mainVacancyText(html);
  const listing = candidate.payload as CompanyListing | undefined;
  if (!detail || !listing?.title) return null;
  return hashedVacancy({
    source: parseSourceKey(site.id), sourceId: candidate.sourceId, name: detail.title,
    employer: listing.employer || site.employer, area: listing.area || 'Не указано', salary: null,
    experience: experience(listing.experience), employment: listing.employment ? 'other' : 'unspecified',
    schedule: 'unspecified', workFormat: workFormat(listing.workFormat), description: detail.description,
    keySkills: Object.freeze([...listing.keySkills]), url: new URL(validateUrl(site.id, resolvedUrl)),
    publishedAt: candidate.publishedAt, sourceQuery: candidate.searchName,
  });
}

export function companyPlatform(site: CompanySite): SearchPlatform<typeof companySearchProfileSchema> {
  return Object.freeze({
    id: site.id, name: site.name, hosts: Object.freeze([...new Set(site.hosts)]), schema: companySearchProfileSchema,
    template: () => ({
      platform: site.id, version: 1, purpose: `Search the public ${site.employer} careers site.`,
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct evidence', query: 'role title' }] },
      capabilities: { maxSearches: 8, queryLanguage: site.queryLanguage },
      rules: Object.freeze([
        'Return at most 8 searches.', 'Use one concise role title per query.',
        'Put translations and alternative titles in separate searches.', ...(site.rules ?? []),
      ]),
    }),
  });
}

function pageAllocation(searches: number, budget: number, maxPages: number): readonly number[] {
  if (searches === 0) return [];
  const base = Math.floor(budget / searches); const remainder = budget % searches;
  return Array.from({ length: searches }, (_, index) => Math.min(maxPages, base + (index < remainder ? 1 : 0)));
}

export async function scrapeCompanySite(
  site: CompanySite, plan: SearchPlan<CompanySearch>, context: SourceContext, maxPages: number,
) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid company-site page limit.');
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
  const allocations = pageAllocation(plan.searches.length, context.limits.searchPageBudgetPerPlatform, maxPages);
  for (let index = 0; index < plan.searches.length && !collector.complete; index += 1) {
    const planned = plan.searches[index]!; let cursor: string | undefined; const cursors = new Set<string>();
    for (let page = 0; page < allocations[index]! && !collector.complete; page += 1) {
      const payload = await context.http.fetchSourceJson(site.id, site.searchUrl(planned.search.query, cursor));
      const decoded = site.listingPage(payload, cursor);
      if (!Array.isArray(decoded.listings)) throw new TypeError(`Company source ${site.id} returned an invalid page.`);
      for (const listing of decoded.listings) {
        if (collector.complete) break;
        if (!listing.title.trim()) throw new TypeError(`Company source ${site.id} returned an empty title.`);
        const publishedAt = listing.publishedAt ? new Date(listing.publishedAt) : undefined;
        if (publishedAt && !Number.isFinite(publishedAt.getTime())) throw new TypeError(`Company source ${site.id} returned an invalid date.`);
        await collector.record({
          source: parseSourceKey(site.id), sourceId: parseSourceVacancyId(listing.sourceId),
          url: context.http.sourceUrl(site.id, listing.url), searchName: planned.search.name,
          title: listing.title, summary: listing.summary, ...(publishedAt ? { publishedAt } : {}), payload: listing,
        }, planned.recipients);
      }
      const next = decoded.nextCursor;
      if (!next || cursors.has(next)) break;
      cursors.add(next); cursor = next;
    }
  }
  return collector.result();
}

export async function normalizeCompanyCandidate(
  site: CompanySite, candidate: VacancyCandidate, context: SourceContext,
): Promise<VacancyInput | null> {
  if (candidate.source !== site.id) throw new Error(`Company provider ${site.id} cannot normalize source ${candidate.source}.`);
  const page = await context.http.fetchSourceHtml(site.id, candidate.url.href);
  return site.vacancy
    ? site.vacancy(site, candidate, page.html, page.url, context)
    : companyVacancyInput(site, candidate, page.html, page.url, context.http.safeVacancyUrl);
}

export function createCompanySiteSource(
  site: CompanySite, options: { readonly maxPages?: number } = {},
): SourceProvider<typeof companySearchProfileSchema> {
  const maxPages = options.maxPages ?? 1;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid company-site page limit.');
  const platform = companyPlatform(site);
  return createSourceProvider({ ...platform,
    async discover(plan, context) {
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...await scrapeCompanySite(site, plan, context, maxPages) };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      await Promise.all(candidates.map(async (candidate) => {
        try { results.set(candidate.sourceId, await normalizeCompanyCandidate(site, candidate, context)); }
        catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(context.errorMessage(error))); }
      }));
      return results;
    },
  });
}
