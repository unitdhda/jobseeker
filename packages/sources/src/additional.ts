import * as v from 'valibot';
import type { SearchPlatform } from './contract.ts';

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const textSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});
export type TextSearchProfile = v.InferOutput<typeof textSearchProfileSchema>;

const textHosts: Record<'habr' | 'rabota', readonly string[]> = {
  habr: ['career.habr.com'], rabota: ['rabota.ru', 'www.rabota.ru'],
};

function textPlatform(id: 'habr' | 'rabota', name: string, rules: string[]): SearchPlatform<typeof textSearchProfileSchema> {
  return {
    id, name, hosts: textHosts[id], schema: textSearchProfileSchema,
    template: () => ({
      platform: id,
      version: 1,
      purpose: `Public ${name} vacancy search.`,
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }] },
      capabilities: { query: 'One concise role title supported by a CV-derived career track', maxSearches: 8 },
      rules: [
        'Each query contains one role title in the language expected by the platform.',
        'Put translations and alternative titles in separate searches.',
        'Do not combine titles with slash, pipe, parentheses, or boolean syntax.',
        'Do not add adjacent occupations, generic industries, location, salary, or work-format terms.',
        ...rules,
      ],
    }),
  };
}

export const habrPlatform = textPlatform('habr', 'Habr Career', [
  'Use Russian or established English vacancy titles that occur on Habr Career.',
]);
export const rabotaPlatform = textPlatform('rabota', 'Работа.ру', [
  'Use Russian role titles because the query becomes an SEO path segment.',
]);

import { errorMessage, sourcesSettings, trace } from './config.ts';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/store';
import { asObject, fetchSourceHtml, htmlText, jobPostings, plainText, russianDate, structuredVacancy, type JsonObject } from './http.ts';
import { VacancySearchCollector } from './http.ts';
import type { SearchPlan } from './contract.ts';

type TextSearch = TextSearchProfile['searches'][number];

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 400));
}

export interface HabrListing { sourceId: string; url: string; title: string; publishedAt?: string }

/**
 * Habr renders each result as a card that carries the posting date in a `datetime` attribute and the real title in
 * a `vacancy-card__title-link`. The card is parsed as a unit because the first `/vacancies/<id>` link inside it is
 * an empty backdrop anchor: scanning links alone took that anchor's empty text, which left 703 of 708 stored habr
 * listings titled with the search query and the candidate prefilter comparing a query against itself.
 *
 * A markup change falls back to the old link scan, so discovery degrades to titles-from-query rather than to
 * nothing at all.
 */
export function habrListings(html: string, base: string): HabrListing[] {
  const listings = new Map<string, HabrListing>();
  // The class token must end at a space or quote, so the card's own `vacancy-card__date` and `__inner` children
  // cannot be mistaken for the start of the next card and cut it short before its date and title.
  for (const card of html.matchAll(/<div class="vacancy-card(?:\s[^"]*)?">[\s\S]*?(?=<div class="vacancy-card(?:\s[^"]*)?">|<\/body|$)/gi)) {
    const block = card[0]!;
    const title = /<a[^>]*class="vacancy-card__title-link"[^>]*href="\/vacancies\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!title) continue;
    const attribute = /<time[^>]*datetime="([^"]+)"/i.exec(block)?.[1];
    const printed = /<time[^>]*>([\s\S]*?)<\/time>/i.exec(block)?.[1];
    const publishedAt = attribute && Number.isFinite(Date.parse(attribute)) ? new Date(attribute).toISOString()
      : printed ? russianDate(htmlText(printed)) ?? undefined : undefined;
    const sourceId = title[1]!;
    listings.set(sourceId, { sourceId, url: new URL(`/vacancies/${sourceId}`, base).toString(),
      title: htmlText(title[2]!), publishedAt });
  }
  if (listings.size) return [...listings.values()];
  for (const match of html.matchAll(/href=["'](\/vacancies\/(\d+))(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const sourceId = match[2]!;
    if (!listings.has(sourceId)) {
      listings.set(sourceId, { sourceId, url: new URL(match[1]!, base).toString().split('?')[0]!, title: htmlText(match[3]!) });
    }
  }
  return [...listings.values()];
}

export async function scrapeHabr(plan: SearchPlan<TextSearch>): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  const pagesPerSearch=Math.max(1,Math.min(sourcesSettings().additionalMaxPages,
    Math.floor(sourcesSettings().searchPageBudgetPerPlatform/Math.max(1,plan.searches.length))));
  searches: for (const { search, recipients } of plan.searches) {
    for (let page = 1; page <= pagesPerSearch; page++) {
      const url = new URL('/vacancies', 'https://career.habr.com');
      url.searchParams.set('q', search.query);
      url.searchParams.set('type', 'all');
      if (page > 1) url.searchParams.set('page', String(page));
      try {
        trace('scrape.search.request', { platform: 'habr', search: search.name, query: search.query, page, url: url.toString() });
        const { html } = await fetchSourceHtml('habr', url.toString());
        const listings = habrListings(html, url.toString());
        for (const listing of listings) {
          await collector.record({ source: 'habr', sourceId: listing.sourceId, url: listing.url,
            searchName: search.name, title: listing.title || search.name, summary: search.name,
            publishedAt: listing.publishedAt }, recipients);
          if (collector.complete) break;
        }
        const found = listings.length;
        trace('scrape.search.result', { platform: 'habr', search: search.name, page, found,
          dated: listings.filter((listing) => listing.publishedAt).length });
        if (collector.complete) break searches;
        if (!found) break;
        await pause();
      } catch (error) {
        console.error(`Failed to read Habr search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function scrapeRabota(plan: SearchPlan<TextSearch>): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  const pagesPerSearch=Math.max(1,Math.min(sourcesSettings().additionalMaxPages,
    Math.floor(sourcesSettings().searchPageBudgetPerPlatform/Math.max(1,plan.searches.length))));
  searches: for (const { search, recipients } of plan.searches) {
    for (let page = 1; page <= pagesPerSearch; page++) {
      try {
        const url = new URL(`/vacancy/${encodeURIComponent(search.query)}/`, 'https://www.rabota.ru');
        if (page > 1) url.searchParams.set('page', String(page));
        trace('scrape.search.request', { platform: 'rabota', search: search.name, query: search.query, page, url: url.toString() });
        const { html } = await fetchSourceHtml('rabota', url.toString());
        const postings = jobPostings(html);
        trace('scrape.search.result', { platform: 'rabota', search: search.name, page, found: postings.length });
        for (const posting of postings) {
          const postingUrl = plainText(posting.url);
          const sourceId = postingUrl.match(/\/vacancy\/(\d+)/)?.[1] ?? plainText(asObject(posting.identifier)?.value);
          if (sourceId) await collector.record({ source: 'rabota', sourceId,
            url: postingUrl || `https://www.rabota.ru/vacancy/${sourceId}/`, searchName: search.name,
            title: plainText(posting.title) || search.name, summary: plainText(posting.description).slice(0, 1_000),
            publishedAt: plainText(posting.datePosted), payload: posting }, recipients);
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        if (!postings.length) break;
        await pause();
      } catch (error) {
        console.error(`Failed to read Работа.ру search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function normalizeAdditionalCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  if (candidate.source === 'habr') {
    const page = await fetchSourceHtml('habr', candidate.url);
    const posting = jobPostings(page.html)[0];
    if (!posting) return null;
    return structuredVacancy('habr', candidate.sourceId, page.url, candidate.searchName, posting);
  }
  if (candidate.source === 'rabota') {
    return structuredVacancy('rabota', candidate.sourceId, candidate.url, candidate.searchName, candidate.payload as JsonObject);
  }
  throw new Error(`Unsupported vacancy source: ${candidate.source}`);
}
