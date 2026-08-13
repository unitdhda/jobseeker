import * as v from 'valibot';
import {
  parseSourceKey,
  parseSourceVacancyId,
  type VacancyCandidate,
  type VacancyInput,
} from '@jobseeker/engine/contracts';
import type { SearchPlan, SearchPlatform } from './contract.ts';
import type { SourceContext } from './context.ts';
import { jobPostings, plainText, structuredVacancy, VacancySearchCollector } from './http.ts';

export interface BoardEntry {
  readonly url: string;
  readonly title: string;
  readonly publishedAt?: string;
}

export interface JsonLdBoard {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly string[];
  listing(page: number): string;
  entries(html: string, base: string): ReadonlyMap<string, BoardEntry>;
  readonly rules: readonly string[];
}

export function postingMatchesQuery(title: string, query: string): boolean {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu) ?? [];
  const haystack = title.toLocaleLowerCase();
  return words.length > 0 && words.every((word) => haystack.includes(word));
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
  return Object.freeze({
    id: board.id, name: board.name, hosts: Object.freeze([...new Set(board.hosts)]),
    schema: boardSearchProfileSchema, enumerates: true,
    template: () => ({
      platform: board.id, version: 1,
      purpose: `Search the enumerated public ${board.name} board by local title matching.`,
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct evidence', query: 'role title' }] },
      capabilities: { maxSearches: 8, enumerates: true },
      rules: Object.freeze(['Return at most 8 searches.', 'Every significant query word must occur in the title.', ...board.rules]),
    }),
  });
}

export async function scrapeJsonLdBoard(
  board: JsonLdBoard, plan: SearchPlan<BoardSearch>, context: SourceContext, maxPages: number,
) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid JSON-LD board page limit.');
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
  const pages = Math.min(maxPages, context.limits.searchPageBudgetPerPlatform);
  for (let page = 1; page <= pages && !collector.complete; page += 1) {
    const listingUrl = board.listing(page);
    const response = await context.http.fetchSourceHtml(board.id, listingUrl);
    const entries = board.entries(response.html, response.url);
    if (!(entries instanceof Map) && typeof entries?.[Symbol.iterator] !== 'function') {
      throw new TypeError(`JSON-LD board ${board.id} returned invalid entries.`);
    }
    if (entries.size === 0) break;
    for (const [sourceId, entry] of entries) {
      if (collector.complete) break;
      if (!entry.title.trim()) throw new TypeError(`JSON-LD board ${board.id} returned an empty title.`);
      const matches = plan.searches.filter(({ search }) => postingMatchesQuery(entry.title, search.query));
      if (matches.length === 0) continue;
      const publishedAt = entry.publishedAt ? new Date(entry.publishedAt) : undefined;
      if (publishedAt && !Number.isFinite(publishedAt.getTime())) throw new TypeError(`JSON-LD board ${board.id} returned an invalid date.`);
      await collector.record({ source: parseSourceKey(board.id), sourceId: parseSourceVacancyId(sourceId),
        url: context.http.sourceUrl(board.id, entry.url), searchName: matches[0]!.search.name,
        title: entry.title, ...(publishedAt ? { publishedAt } : {}) },
      matches.flatMap(({ recipients }) => recipients));
    }
  }
  return collector.result();
}

export async function normalizeJsonLdCandidate(
  board: JsonLdBoard, candidate: VacancyCandidate, context: SourceContext,
): Promise<VacancyInput | null> {
  if (candidate.source !== board.id) throw new Error(`JSON-LD board ${board.id} cannot normalize source ${candidate.source}.`);
  const page = await context.http.fetchSourceHtml(board.id, candidate.url.href);
  const postings = jobPostings(page.html);
  if (postings.length === 0) return null;
  const title = candidate.title.toLocaleLowerCase();
  const posting = postings.find((item) => plainText(item.title).toLocaleLowerCase() === title)
    ?? (postings.length === 1 ? postings[0] : undefined);
  if (!posting) throw new Error(`JSON-LD board ${board.id} detail contains no matching JobPosting.`);
  return structuredVacancy(board.id, candidate.sourceId, page.url, candidate.searchName, posting);
}
