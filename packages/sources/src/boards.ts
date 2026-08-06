/**
 * Generic driver internals for server-rendered boards whose vacancy pages publish schema.org JobPosting. The board
 * definition enumerates listing pages, and discovery filters entries by title when no server-side search is
 * available. Carrying the real title matters because the candidate prefilter scores on it.
 */
import * as v from 'valibot';
import type { SourceContext } from './context.ts';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import { jobPostings, structuredVacancy, VacancySearchCollector } from './http.ts';
import type { SearchPlan } from './contract.ts';
import type { SearchPlatform } from './contract.ts';

export interface BoardEntry { url: string; title: string; publishedAt?: string }

export interface JsonLdBoard {
  id: string;
  name: string;
  hosts: readonly string[];
  /** Listing address for one page; these boards ignore text queries, so no query is sent. */
  listing(page: number): string;
  /** Extracts sourceId → {url, title} from listing HTML. */
  entries(html: string, base: string): Map<string, BoardEntry>;
  rules: string[];
}

/** Every significant query word must occur in the listing title. */
export function postingMatchesQuery(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((word) => word.length > 2);
  if (!words.length) return false;
  const haystack = title.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const boardSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});
export type BoardSearchProfile = v.InferOutput<typeof boardSearchProfileSchema>;
export type BoardSearch = BoardSearchProfile['searches'][number];

export function boardPlatform(board: JsonLdBoard): SearchPlatform<typeof boardSearchProfileSchema> {
  return {
    id: board.id, name: board.name, hosts: board.hosts, schema: boardSearchProfileSchema,
    // The whole board is listed whatever the query, so one enumeration serves every user's searches at once.
    enumerates: true,
    template: () => ({
      platform: board.id, version: 1,
      purpose: `Public ${board.name} board. The whole board is listed and matched against the query by title.`,
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }] },
      capabilities: {
        query: 'One concise role title; every word must appear in a listing title for the vacancy to be kept',
        maxSearches: 8,
      },
      rules: [
        'Each query contains one role title in the language expected by the platform.',
        'Keep queries short, because every word must occur in the vacancy title.',
        'Put translations and alternative titles in separate searches.',
        'Do not combine titles with slash, pipe, parentheses, or boolean syntax.',
        'Do not add adjacent occupations, generic industries, location, salary, or work-format terms.',
        ...board.rules,
      ],
    }),
  };
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 400));
}

export async function scrapeJsonLdBoard(board: JsonLdBoard, plan: SearchPlan<BoardSearch>, context: SourceContext,
  maxPages: number): Promise<{ seen: number; discovered: number }> {
  const id = board.id;
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit,
    context.recordListingCandidate);
  if (!plan.searches.length) return collector.result();
  const pages = Math.max(1, Math.min(maxPages, context.limits.searchPageBudgetPerPlatform));
  const seenIds = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const url = board.listing(page);
    try {
      context.trace('scrape.search.request', { platform: id, page, url });
      const { html, url: resolved } = await context.http.fetchSourceHtml(id, url);
      const entries = board.entries(html, resolved);
      let fresh = 0;
      for (const [sourceId, entry] of entries) {
        if (seenIds.has(sourceId)) continue;
        seenIds.add(sourceId); fresh++;
        const planned = plan.searches.find((candidate) => postingMatchesQuery(entry.title, candidate.search.query));
        if (!planned) continue;
        await collector.record({ source: id, sourceId, url: entry.url, searchName: planned.search.name,
          title: entry.title, summary: entry.title, publishedAt: entry.publishedAt }, planned.recipients);
        if (collector.complete) break;
      }
      context.trace('scrape.search.result', { platform: id, page, found: entries.size, fresh, kept: collector.result().seen });
      if (collector.complete || !fresh) break;
      await pause();
    } catch (error) {
      console.error(`Failed to read ${board.name} listing page ${page}: ${context.errorMessage(error)}`);
      break;
    }
  }
  return collector.result();
}

export async function normalizeJsonLdCandidate(board: JsonLdBoard, candidate: VacancyCandidate,
  context: SourceContext): Promise<VacancyInput | null> {
  if (candidate.source !== board.id) throw new Error(`Board provider ${board.id} cannot normalize ${candidate.source}.`);
  const page = await context.http.fetchSourceHtml(board.id, candidate.url);
  const posting = jobPostings(page.html)[0];
  if (!posting) return null;
  return structuredVacancy(board.id, candidate.sourceId, page.url, candidate.searchName, posting);
}
