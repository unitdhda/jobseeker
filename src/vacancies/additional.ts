import * as v from 'valibot';
import type { SearchPlatform } from './registry.ts';

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

function textPlatform(id: 'habr' | 'rabota', name: string, rules: string[]): SearchPlatform<typeof textSearchProfileSchema> {
  return {
    id, name, schema: textSearchProfileSchema,
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

import { config } from '../config.ts';
import type { VacancyCandidate, VacancyInput } from '../database.ts';
import { asObject, fetchSourceHtml, htmlText, jobPostings, plainText, structuredVacancy, type JsonObject } from './http.ts';
import { trace } from '../observability.ts';
import { errorMessage } from '../observability.ts';
import { VacancySearchCollector } from './http.ts';

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 400));
}

export async function scrapeHabr(userId: string, profile: TextSearchProfile): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
  const pagesPerSearch=Math.max(1,Math.min(config.additionalMaxPages,
    Math.floor(config.searchPageBudgetPerPlatform/Math.max(1,profile.searches.length))));
  searches: for (const search of profile.searches) {
    for (let page = 1; page <= pagesPerSearch; page++) {
      const url = new URL('/vacancies', 'https://career.habr.com');
      url.searchParams.set('q', search.query);
      url.searchParams.set('type', 'all');
      if (page > 1) url.searchParams.set('page', String(page));
      try {
        trace('scrape.search.request', { platform: 'habr', search: search.name, query: search.query, page, url: url.toString() });
        const { html } = await fetchSourceHtml('habr', url.toString());
        let found = 0;
        for (const match of html.matchAll(/href=["'](\/vacancies\/\d+)(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          const vacancyUrl = new URL(match[1], url).toString().split('?')[0];
          const sourceId = vacancyUrl.match(/\/vacancies\/(\d+)/)?.[1];
          if (sourceId) {
            found++;
            await collector.record({ source: 'habr', sourceId, url: vacancyUrl, searchName: search.name,
              title: htmlText(match[2]) || search.name, summary: search.name });
          }
          if (collector.complete) break;
        }
        trace('scrape.search.result', { platform: 'habr', search: search.name, page, found });
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

export async function scrapeRabota(userId: string, profile: TextSearchProfile): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
  const pagesPerSearch=Math.max(1,Math.min(config.additionalMaxPages,
    Math.floor(config.searchPageBudgetPerPlatform/Math.max(1,profile.searches.length))));
  searches: for (const search of profile.searches) {
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
            publishedAt: plainText(posting.datePosted), payload: posting });
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
