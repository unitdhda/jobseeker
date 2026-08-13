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
import { arrayAt, textAt, dateAt, stringArray } from './api-example.ts';
import { textSearchProfileSchema, textSearchTemplate, type TextSearch } from './profile.ts';

const origin = 'https://www.tbank.ru';
export interface TbankListing extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt?: string;
}

function safeToken(value: string, name: string): string {
  if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(value)) throw new TypeError(`Invalid T-Bank ${name}.`);
  return value;
}
export function tbankRequestBody(category: string, group: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid T-Bank offset.');
  return JSON.stringify({ operationName: 'CareerVacancies', variables: {
    category: safeToken(category, 'category'), group: safeToken(group, 'group'), offset, limit: 50,
  } });
}
export function tbankListings(payload: unknown, group: string): readonly TbankListing[] {
  const items = arrayAt(payload, 'data', 'vacancies', 'items');
  return Object.freeze(items.flatMap((item) => {
    const id = textAt(item, 'id'); const title = textAt(item, 'title');
    if (!id || !title) return [];
    const slug = textAt(item, 'slug') || id;
    return [{ ...item, id, title, url: `${origin}/career/${encodeURIComponent(group)}/vacancies/${encodeURIComponent(slug)}`,
      ...(dateAt(item, 'publishedAt') ? { publishedAt: dateAt(item, 'publishedAt') } : {}) }];
  }));
}

function findVacancyState(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findVacancyState(item); if (found) return found; }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.title === 'string' && (typeof object.description === 'string' || typeof object.content === 'string')) return object;
  for (const item of Object.values(object)) { const found = findVacancyState(item); if (found) return found; }
  return null;
}
export function tbankVacancyFromHtml(html: string): Record<string, unknown> | null {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try { const found = findVacancyState(JSON.parse(match[1]!)); if (found) return found; } catch { /* Try another SSR block. */ }
  }
  return null;
}
export function tbankVacancyInput(
  candidate: VacancyCandidate, html: string, resolvedUrl: string,
  safeUrl: (source: string, input: string) => string,
): VacancyInput | null {
  const state = tbankVacancyFromHtml(html); if (!state) return null;
  if (textAt(state, 'status') === 'closed' || Boolean(textAt(state, 'archivedAt'))) return null;
  const description = htmlText(textAt(state, 'description') || textAt(state, 'content'));
  const title = textAt(state, 'title') || candidate.title;
  if (!title || description.length < 20) throw new Error('T-Bank vacancy detail is incomplete.');
  const publishedAt = dateAt(state, 'publishedAt');
  return hashedVacancy({ source: candidate.source, sourceId: candidate.sourceId, name: title,
    employer: 'Т-Банк', area: textAt(state, 'location') || 'Не указано', salary: null,
    experience: { kind: 'unspecified' }, employment: 'unspecified', schedule: 'unspecified',
    workFormat: /remote|удален/iu.test(textAt(state, 'workFormat')) ? 'remote' : 'unspecified',
    description, keySkills: stringArray(state.skills), url: new URL(safeUrl('tbank', resolvedUrl)),
    publishedAt: publishedAt ? new Date(publishedAt) : candidate.publishedAt, sourceQuery: candidate.searchName });
}

export function tbankSource(options: { readonly maxPages?: number; readonly category?: string; readonly group?: string } = {}) {
  assertToolkitInitialized(); const maxPages = options.maxPages ?? 1;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid T-Bank page limit.');
  const category = safeToken(options.category ?? 'it', 'category'); const group = safeToken(options.group ?? 'technology', 'group');
  const platform: SearchPlatform<typeof textSearchProfileSchema> = { id: 'tbank', name: 'Т-Банк Карьера',
    hosts: ['www.tbank.ru'], schema: textSearchProfileSchema, enumerates: true,
    template: () => textSearchTemplate('tbank', 'Т-Банк Карьера', 'Russian or English',
      ['The provider enumerates its configured category and matches titles locally.']) };
  return createSourceProvider({ ...platform,
    async discover(plan: SearchPlan<TextSearch>, context) {
      const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      const pages = Math.min(maxPages, context.limits.searchPageBudgetPerPlatform);
      for (let page = 0; page < pages && !collector.complete; page += 1) {
        const payload = await context.http.fetchSourceJson('tbank', `${origin}/api/common/v1/graphql`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: tbankRequestBody(category, group, page * 50),
        });
        const listings = tbankListings(payload, group); if (listings.length === 0) break;
        for (const item of listings) {
          const matches = plan.searches.filter(({ search }) => {
            const words = search.query.toLocaleLowerCase().split(/\s+/u).filter((word) => word.length > 1);
            return words.length > 0 && words.every((word) => item.title.toLocaleLowerCase().includes(word));
          });
          if (matches.length === 0) continue;
          await collector.record({ source: parseSourceKey('tbank'), sourceId: parseSourceVacancyId(item.id),
            url: context.http.sourceUrl('tbank', item.url), searchName: matches[0]!.search.name, title: item.title,
            ...(item.publishedAt ? { publishedAt: new Date(item.publishedAt) } : {}), payload: item },
          matches.flatMap(({ recipients }) => recipients));
        }
      }
      return { searches: plan.searches.length, users: users.size, ...collector.result() };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      await Promise.all(candidates.map(async (candidate) => {
        try { const page = await context.http.fetchSourceHtml('tbank', candidate.url.href);
          results.set(candidate.sourceId, tbankVacancyInput(candidate, page.html, page.url, context.http.safeVacancyUrl)); }
        catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(context.errorMessage(error))); }
      })); return results;
    },
  });
}
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(tbankSource({ maxPages: examplePages(api) }));
}
