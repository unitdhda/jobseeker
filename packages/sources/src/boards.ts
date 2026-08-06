/**
 * Server-rendered boards whose vacancy pages publish schema.org JobPosting. Neither board honours a text query
 * parameter — both return their whole listing regardless — so discovery enumerates pages and filters by the
 * listing title instead. Carrying the real title matters because the candidate prefilter scores on it.
 */
import * as v from 'valibot';
import { errorMessage, sourcesSettings, trace } from './config.ts';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import { fetchSourceHtml, htmlText, jobPostings, russianDate, structuredVacancy, VacancySearchCollector } from './http.ts';
import { postingMatchesQuery } from './ats.ts';
import type { SearchPlan } from './contract.ts';
import type { SearchPlatform } from './contract.ts';

export type JsonLdBoardId = 'geekjob' | 'avito';

export interface BoardEntry { url: string; title: string; publishedAt?: string }

interface JsonLdBoard {
  id: JsonLdBoardId;
  name: string;
  /** Listing address for one page; these boards ignore text queries, so no query is sent. */
  listing(page: number): string;
  /** Extracts sourceId → {url, title} from listing HTML. */
  entries(html: string, base: string): Map<string, BoardEntry>;
  rules: string[];
}

function absolute(base: string, href: string): string {
  return new URL(href, base).toString().split('?')[0]!;
}

export const jsonLdBoards: Record<JsonLdBoardId, JsonLdBoard> = {
  geekjob: {
    id: 'geekjob', name: 'GeekJob',
    listing(page) {
      const url = new URL('/vacancies', 'https://geekjob.ru');
      if (page > 1) url.searchParams.set('page', String(page));
      return url.toString();
    },
    entries(html, base) {
      // The row prints its date as Russian text in a trailing <time>, with no machine-readable attribute.
      const dates = new Map<string, string>();
      for (const match of html.matchAll(
        /<time[^>]*datetime-info[^>]*>[\s\S]*?href="\/vacancy\/([a-f0-9]{12,})"[^>]*>([^<]*)<\/a>/gi)) {
        const posted = russianDate(htmlText(match[2]!));
        if (posted) dates.set(match[1]!, posted);
      }
      const found = new Map<string, BoardEntry>();
      for (const match of html.matchAll(
        /class="truncate vacancy-name">\s*<a href="(\/vacancy\/([a-f0-9]{12,}))"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const title = htmlText(match[3]!);
        const publishedAt = dates.get(match[2]!);
        if (title) found.set(match[2]!, { url: absolute(base, match[1]!), title, ...publishedAt ? { publishedAt } : {} });
      }
      return found;
    },
    rules: ['Use Russian or established English IT role titles that occur on GeekJob.'],
  },
  avito: {
    id: 'avito', name: 'Avito Careers',
    listing(page) {
      const url = new URL('/vacancies/', 'https://career.avito.com');
      if (page > 1) url.searchParams.set('page', String(page));
      return url.toString();
    },
    entries(html, base) {
      const found = new Map<string, BoardEntry>();
      // Avito's listing prints no date anywhere, so its candidates carry none until they are normalized.
      for (const match of html.matchAll(
        /href="(\/vacancies\/[a-z0-9_-]+\/(\d+)\/?)"\s+class="vacancies-section__item-name"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const title = htmlText(match[3]!);
        if (title) found.set(match[2]!, { url: absolute(base, match[1]!), title });
      }
      return found;
    },
    rules: ['Use Russian role titles because Avito publishes its own vacancies in Russian.'],
  },
};

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

const boardHosts: Record<JsonLdBoardId, readonly string[]> = {
  geekjob: ['geekjob.ru', 'www.geekjob.ru'], avito: ['career.avito.com'],
};

export function boardPlatform(id: JsonLdBoardId): SearchPlatform<typeof boardSearchProfileSchema> {
  const board = jsonLdBoards[id];
  return {
    id, name: board.name, hosts: boardHosts[id], schema: boardSearchProfileSchema,
    // The whole board is listed whatever the query, so one enumeration serves every user's searches at once.
    enumerates: true,
    template: () => ({
      platform: id, version: 1,
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

export async function scrapeJsonLdBoard(id: JsonLdBoardId,
  plan: SearchPlan<BoardSearch>): Promise<{ seen: number; discovered: number }> {
  const board = jsonLdBoards[id];
  const collector = new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  if (!plan.searches.length) return collector.result();
  const pages = Math.max(1, Math.min(sourcesSettings().additionalMaxPages, sourcesSettings().searchPageBudgetPerPlatform));
  const seenIds = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const url = board.listing(page);
    try {
      trace('scrape.search.request', { platform: id, page, url });
      const { html, url: resolved } = await fetchSourceHtml(id, url);
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
      trace('scrape.search.result', { platform: id, page, found: entries.size, fresh, kept: collector.result().seen });
      if (collector.complete || !fresh) break;
      await pause();
    } catch (error) {
      console.error(`Failed to read ${board.name} listing page ${page}: ${errorMessage(error)}`);
      break;
    }
  }
  return collector.result();
}

export async function normalizeJsonLdCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  const id = candidate.source as JsonLdBoardId;
  if (!jsonLdBoards[id]) throw new Error(`Unsupported board source: ${candidate.source}`);
  const page = await fetchSourceHtml(id, candidate.url);
  const posting = jobPostings(page.html)[0];
  if (!posting) return null;
  return structuredVacancy(id, candidate.sourceId, page.url, candidate.searchName, posting);
}
