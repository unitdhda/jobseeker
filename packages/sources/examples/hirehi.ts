import * as v from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { SearchPlan, SearchPlatform } from '@jobseeker/sources';
import { entriesOf, boardListings } from './text.ts';
import {
  assertToolkitInitialized,
  createSourceProvider,
  examplePages,
  initToolkit,
  jobPostings,
  parseSourceKey,
  parseSourceVacancyId,
  postingMatchesQuery,
  structuredVacancy,
  VacancySearchCollector,
  type SourceExtensionApi,
} from './toolkit.ts';

export const hireHiSpecializations = Object.freeze(['development', 'analytics', 'management', 'design', 'marketing', 'support'] as const);
export const maxHireHiSearches = 8;
const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const hireHiSearchProfileSchema = v.strictObject({ version: v.literal(1), searches: v.pipe(v.array(v.strictObject({
  name: label, rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)), query: label,
  specialization: v.picklist(hireHiSpecializations),
})), v.maxLength(maxHireHiSearches)) });
export type HireHiSearchProfile = v.InferOutput<typeof hireHiSearchProfileSchema>;
export type HireHiSearch = HireHiSearchProfile['searches'][number];

export const hireHiPlatform: SearchPlatform<typeof hireHiSearchProfileSchema> = {
  id: 'hirehi', name: 'HireHi', hosts: ['hirehi.ru', 'www.hirehi.ru'], schema: hireHiSearchProfileSchema,
  template: () => ({ platform: 'hirehi', version: 1, purpose: 'Generate constrained HireHi specialization searches.',
    jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct evidence', query: 'role title', specialization: 'development' }] },
    capabilities: { maxSearches: maxHireHiSearches, specializations: hireHiSpecializations },
    rules: ['Return at most 8 searches.', 'Choose exactly one supported specialization.', 'Use one concise role title.'] }),
};

export function hireHiSearchUrl(search: HireHiSearch, page: number): string {
  const url = new URL(`/vacancies/${encodeURIComponent(search.specialization)}`, 'https://hirehi.ru');
  url.searchParams.set('query', search.query); if (page > 1) url.searchParams.set('page', String(page)); return url.href;
}

export function hireHiListingUrls(html: string, base = 'https://hirehi.ru') {
  return entriesOf(boardListings(html, base,
    /<a\b[^>]*href=["'](?<url>\/vacancies\/[^"']+\/\d+)["'][^>]*>(?<title>[\s\S]*?)<\/a>/giu));
}

export function hireHiVacancyPosting(html: string, title: string) {
  const postings = jobPostings(html);
  return postings.find((posting) => String(posting.title ?? '').trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase())
    ?? (postings.length === 1 ? postings[0] : null);
}

export function hireHiSource(options: { readonly maxPages?: number } = {}) {
  assertToolkitInitialized(); const maxPages = options.maxPages ?? 1;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid HireHi page limit.');
  return createSourceProvider({ ...hireHiPlatform,
    async discover(plan: SearchPlan<HireHiSearch>, context) {
      const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      const pages = Math.min(maxPages, Math.max(1, Math.floor(context.limits.searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
      for (const planned of plan.searches) for (let page = 1; page <= pages && !collector.complete; page += 1) {
        const response = await context.http.fetchSourceHtml('hirehi', hireHiSearchUrl(planned.search, page));
        const entries = hireHiListingUrls(response.html, response.url); if (entries.size === 0) break;
        for (const [sourceId, entry] of entries) {
          if (!postingMatchesQuery(entry.title, planned.search.query)) continue;
          await collector.record({ source: parseSourceKey('hirehi'), sourceId: parseSourceVacancyId(sourceId),
            url: context.http.sourceUrl('hirehi', entry.url), searchName: planned.search.name, title: entry.title,
            ...(entry.publishedAt ? { publishedAt: new Date(entry.publishedAt) } : {}) }, planned.recipients);
        }
      }
      return { searches: plan.searches.length, users: users.size, ...collector.result() };
    },
    async normalize(candidates: readonly VacancyCandidate[], context) {
      const results = new Map<string, VacancyInput | null | Error>();
      await Promise.all(candidates.map(async (candidate) => {
        try {
          const response = await context.http.fetchSourceHtml('hirehi', candidate.url.href);
          const posting = hireHiVacancyPosting(response.html, candidate.title);
          results.set(candidate.sourceId, posting ? structuredVacancy('hirehi', candidate.sourceId, response.url, candidate.searchName, posting) : null);
        } catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(context.errorMessage(error))); }
      }));
      return results;
    },
  });
}

export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(hireHiSource({ maxPages: examplePages(api) }));
}
