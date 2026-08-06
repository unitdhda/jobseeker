/** Generic JSON API provider assembled through the public createSourceProvider contract. */
import type { BaseIssue, BaseSchema } from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { PlatformSearch, SearchPlan, SearchPlatform } from '../contract.ts';
import type { SourceContext } from '../context.ts';
import { sourceUserAgent, VacancySearchCollector } from '../http.ts';
import { createSourceProvider, type SourceProvider } from '../sources.ts';

export interface ApiListing {
  sourceId: string;
  url: string;
  title: string;
  summary?: string;
  publishedAt?: string;
  payload?: unknown;
}

export interface ApiListingPage {
  listings: readonly ApiListing[];
  nextCursor?: string;
}

export type ApiRequestPhase = 'listing' | 'detail';

export interface ApiSourceDefinition<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>
  extends SearchPlatform<S> {
  searchName(search: PlatformSearch<S>): string;
  searchUrl(search: PlatformSearch<S>, cursor?: string): string;
  /** `cursor` is the value the page was requested with, for codecs whose payloads do not echo their position. */
  listingPage(payload: unknown, search: PlatformSearch<S>, cursor?: string): ApiListingPage;
  /** Omit when listing payloads are already complete and normalization needs no second request. */
  detailUrl?(candidate: VacancyCandidate): string;
  vacancy(candidate: VacancyCandidate, payload: unknown, context: SourceContext):
    Promise<VacancyInput | null> | VacancyInput | null;
  requestInit?(phase: ApiRequestPhase, candidate?: VacancyCandidate): RequestInit;
}

export interface ApiSourceOptions { maxPages?: number }

function requestInit<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  definition: ApiSourceDefinition<S>, phase: ApiRequestPhase, candidate?: VacancyCandidate,
): RequestInit {
  const supplied = definition.requestInit?.(phase, candidate) ?? {};
  const headers = new Headers(supplied.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (!headers.has('user-agent')) headers.set('user-agent', sourceUserAgent);
  return { ...supplied, headers, signal: supplied.signal ?? AbortSignal.timeout(45_000) };
}

async function discoverApi<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  definition: ApiSourceDefinition<S>, plan: SearchPlan<PlatformSearch<S>>, context: SourceContext, maxPages: number,
): Promise<{ seen: number; discovered: number; discoveredBySearch?: Record<string, number> }> {
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit,
    context.recordListingCandidate);
  const pagesPerSearch = Math.max(1, Math.min(maxPages,
    Math.floor(context.limits.searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
  searches: for (const { search, recipients } of plan.searches) {
    let cursor: string | undefined;
    for (let page = 1; page <= pagesPerSearch; page++) {
      const payload = await context.http.fetchSourceJson(definition.id,
        definition.searchUrl(search, cursor), requestInit(definition, 'listing'));
      const result = definition.listingPage(payload, search, cursor);
      context.trace('scrape.search.result', { platform: definition.id, page, found: result.listings.length });
      for (const listing of result.listings) {
        if (!listing.sourceId || !listing.title) continue;
        await collector.record({
          source: definition.id,
          sourceId: listing.sourceId,
          url: context.http.safeVacancyUrl(definition.id, listing.url),
          searchName: definition.searchName(search),
          title: listing.title,
          summary: (listing.summary ?? '').slice(0, 1_000),
          publishedAt: listing.publishedAt,
          payload: listing.payload ?? listing,
        }, recipients);
        if (collector.complete) break;
      }
      if (collector.complete) break searches;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  }
  return collector.result();
}

/** Creates a fresh provider for paginated JSON listings and optional JSON detail requests. */
export function createApiSource<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  definition: ApiSourceDefinition<S>, options: ApiSourceOptions = {},
): SourceProvider<S> {
  const { id, name, hosts, schema, template, enumerates, mergeText } = definition;
  return createSourceProvider({
    id, name, hosts, schema, template, enumerates, mergeText,
    async discover(plan, context) {
      const result = await discoverApi(definition, plan, context, options.maxPages ?? 1);
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...result };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      for (const candidate of candidates) {
        try {
          const payload = definition.detailUrl
            ? await context.http.fetchSourceJson(definition.id, definition.detailUrl(candidate),
              requestInit(definition, 'detail', candidate))
            : candidate.payload;
          results.set(candidate.sourceId, await definition.vacancy(candidate, payload, context));
        } catch (error) {
          results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return results;
    },
  });
}
