/**
 * Лаборатория Касперского first-party careers. The site is a Next.js App Router app whose only data channel is
 * RSC payloads, but its search route and vacancy pages are fully server-rendered, so discovery reads the search
 * page's plain anchors and normalization reads the vacancy page's h1/main text.
 */
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import {
  createSourceProvider, hashedVacancy, htmlText, VacancySearchCollector, type JsonObject,
} from '@jobseeker/sources';
import { mainVacancyText } from '@jobseeker/sources/drivers/company-site';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';

const id = 'kaspersky';
const employer = 'Лаборатория Касперского';
const origin = 'https://careers.kaspersky.ru';

export interface KasperskySourceOptions { maxPages?: number }

export function kasperskySearchUrl(query: string): string {
  const url = new URL('/vacancies/search', origin);
  url.searchParams.set('q', query);
  return url.toString();
}

export interface KasperskyEntry { sourceId: string; url: string; title: string }

export function kasperskyEntries(html: string): KasperskyEntry[] {
  const found = new Map<string, KasperskyEntry>();
  for (const match of html.matchAll(/href="\/vacancy\/(\d+)"[^>]*>(?:<span[^>]*>)?([^<]{3,200})/g)) {
    const sourceId = match[1]!, title = htmlText(match[2]!);
    if (title && !found.has(sourceId)) found.set(sourceId, { sourceId, url: `${origin}/vacancy/${sourceId}`, title });
  }
  return [...found.values()];
}

/** City and skill names ride in the page's RSC payload with backslash-escaped quotes. */
export function kasperskyFlightNames(html: string, field: 'cities' | 'skills'): string[] {
  const block = new RegExp(`\\\\?"${field}\\\\?":\\\\?\\[(.{0,600}?)\\\\?\\]`, 's').exec(html)?.[1] ?? '';
  const names: string[] = [];
  for (const match of block.matchAll(/\\?"name\\?":\\?"((?:[^"\\]|\\\\.)+?)\\?"/g)) {
    const value = htmlText(match[1]!.replaceAll('\\"', '"'));
    if (value && !names.includes(value)) names.push(value);
  }
  return names;
}

export function kasperskyVacancyInput(candidate: VacancyCandidate, html: string, resolvedUrl: string,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = mainVacancyText(html);
  if (!detail) return null;
  // The page's <main> continues into similar-vacancy teasers and application chrome after the advert body.
  const description = detail.description.split(/Похожие вакансии|Similar vacancies/)[0]!.trim();
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name: detail.title,
    employer,
    area: kasperskyFlightNames(html, 'cities').join(', ') || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience: '',
    employment: '',
    schedule: '',
    workFormat: '',
    description,
    keySkills: kasperskyFlightNames(html, 'skills').slice(0, 30),
    url: validateUrl(id, resolvedUrl),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

/** Fresh Kaspersky provider; register it in any createSources() collection. */
export function kasperskySource(options: KasperskySourceOptions = {}) {
  void options;
  return createSourceProvider({
    id,
    name: 'Kaspersky Careers',
    hosts: ['careers.kaspersky.ru'],
    schema: companySearchProfileSchema,
    template: () => companySearchTemplate(id, employer),
    async discover(plan, context) {
      const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit,
        context.recordListingCandidate);
      searches: for (const { search, recipients } of plan.searches) {
        try {
          context.trace('scrape.search.request', { platform: id });
          const page = await context.http.fetchSourceHtml(id, kasperskySearchUrl(search.query));
          const entries = kasperskyEntries(page.html);
          context.trace('scrape.search.result', { platform: id, found: entries.length });
          for (const entry of entries) {
            await collector.record({
              source: id, sourceId: entry.sourceId, url: context.http.safeVacancyUrl(id, entry.url),
              searchName: search.name, title: entry.title, summary: entry.title,
              payload: entry as unknown as JsonObject,
            }, recipients);
            if (collector.complete) break searches;
          }
        } catch (error) {
          console.error(`Failed to search Kaspersky Careers: ${context.errorMessage(error)}`);
        }
      }
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...collector.result() };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      for (const candidate of candidates) {
        try {
          const page = await context.http.fetchSourceHtml(id, candidate.url);
          results.set(candidate.sourceId,
            kasperskyVacancyInput(candidate, page.html, page.url, context.http.safeVacancyUrl));
        } catch (error) {
          results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return results;
    },
  });
}
