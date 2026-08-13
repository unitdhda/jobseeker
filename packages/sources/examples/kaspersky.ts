import * as v from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { SearchPlan, SearchPlatform } from '@jobseeker/sources';
import {
  assertToolkitInitialized,
  createSourceProvider,
  examplePages,
  hashedVacancy,
  htmlText,
  initToolkit,
  parseSourceKey,
  parseSourceVacancyId,
  plainText,
  VacancySearchCollector,
  type SourceExtensionApi,
} from './toolkit.ts';
import { textSearchProfileSchema, textSearchTemplate, type TextSearch } from './profile.ts';

const origin = 'https://careers.kaspersky.ru';
export function kasperskySearchUrl(query: string): string {
  const url = new URL('/vacancies', origin); url.searchParams.set('search', query); return url.href;
}
export interface KasperskyEntry { readonly sourceId: string; readonly url: string; readonly title: string }
export function kasperskyEntries(html: string): readonly KasperskyEntry[] {
  const output = new Map<string, KasperskyEntry>();
  for (const match of html.matchAll(/<a\b[^>]*href=["'](?<url>\/vacancies\/[^"']+)["'][^>]*>(?<title>[\s\S]*?)<\/a>/giu)) {
    const url = match.groups?.url; const title = htmlText(match.groups?.title ?? ''); const sourceId = url?.split('/').filter(Boolean).at(-1);
    if (url && title && sourceId) output.set(sourceId, { sourceId, url: new URL(url, origin).href, title });
  }
  return Object.freeze([...output.values()]);
}
export function kasperskyFlightNames(html: string, field: 'cities' | 'skills'): readonly string[] {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)) {
    if (!match[1]?.includes(field)) continue;
    try {
      const parsed = JSON.parse(match[1]); const values = parsed?.[field];
      if (Array.isArray(values)) return Object.freeze(values.map((value: unknown) => plainText(value)).filter(Boolean));
    } catch { /* Other server-component scripts may still be usable. */ }
  }
  return [];
}
function detailText(html: string): { readonly title: string; readonly description: string } | null {
  const title = htmlText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu.exec(html)?.[1] ?? '');
  const description = htmlText(/<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(html)?.[1] ?? '');
  return title && description.length >= 20 ? { title, description } : null;
}
export function kasperskyVacancyInput(candidate: VacancyCandidate, html: string, resolvedUrl: string,
  safeUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = detailText(html); if (!detail) return null;
  return hashedVacancy({ source: candidate.source, sourceId: candidate.sourceId, name: detail.title, employer: 'Лаборатория Касперского',
    area: kasperskyFlightNames(html, 'cities').join(', ') || 'Не указано', salary: null,
    experience: { kind: 'unspecified' }, employment: 'unspecified', schedule: 'unspecified', workFormat: 'unspecified',
    description: detail.description, keySkills: kasperskyFlightNames(html, 'skills'), url: new URL(safeUrl('kaspersky', resolvedUrl)),
    publishedAt: candidate.publishedAt, sourceQuery: candidate.searchName });
}
export function kasperskySource(options: { readonly maxPages?: number } = {}) {
  assertToolkitInitialized(); const maxPages = options.maxPages ?? 1;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid Kaspersky page limit.');
  const platform: SearchPlatform<typeof textSearchProfileSchema> = { id: 'kaspersky', name: 'Kaspersky Careers',
    hosts: ['careers.kaspersky.ru'], schema: textSearchProfileSchema,
    template: () => textSearchTemplate('kaspersky', 'Kaspersky Careers', 'Russian or English') };
  return createSourceProvider({ ...platform,
    async discover(plan: SearchPlan<TextSearch>, context) {
      const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      const pages = Math.min(maxPages, Math.max(1, Math.floor(context.limits.searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
      for (const planned of plan.searches) for (let page = 1; page <= pages && !collector.complete; page += 1) {
        const url = new URL(kasperskySearchUrl(planned.search.query)); if (page > 1) url.searchParams.set('page', String(page));
        const response = await context.http.fetchSourceHtml('kaspersky', url.href); const entries = kasperskyEntries(response.html);
        if (entries.length === 0) break;
        for (const entry of entries) await collector.record({ source: parseSourceKey('kaspersky'),
          sourceId: parseSourceVacancyId(entry.sourceId), url: context.http.sourceUrl('kaspersky', entry.url),
          searchName: planned.search.name, title: entry.title }, planned.recipients);
      }
      return { searches: plan.searches.length, users: users.size, ...collector.result() };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      await Promise.all(candidates.map(async (candidate) => {
        try { const page = await context.http.fetchSourceHtml('kaspersky', candidate.url.href);
          results.set(candidate.sourceId, kasperskyVacancyInput(candidate, page.html, page.url, context.http.safeVacancyUrl)); }
        catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(context.errorMessage(error))); }
      })); return results;
    },
  });
}
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(kasperskySource({ maxPages: examplePages(api) }));
}
