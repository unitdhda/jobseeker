import type { VacancyCandidate, VacancyCandidateInput, VacancyInput } from '@jobseeker/engine/contracts';
import { parseSourceKey, parseSourceVacancyId } from '@jobseeker/engine/contracts';
import type { PlatformSearch, SearchPlan, SearchPlatform, SourceSchema } from '../contract.ts';
import type { SourceContext } from '../context.ts';
import { sourceUserAgent, VacancySearchCollector } from '../http.ts';
import { createSourceProvider, type SourceProvider } from '../sources.ts';

export interface ApiListing {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly summary?: string;
  readonly publishedAt?: string;
  readonly payload?: unknown;
}

export interface ApiListingPage {
  readonly listings: readonly ApiListing[];
  readonly nextCursor?: string;
}

export type ApiRequestPhase = 'listing' | 'detail';

export interface ApiSourceDefinition<S extends SourceSchema> extends SearchPlatform<S> {
  searchName(search: PlatformSearch<S>): string;
  searchUrl(search: PlatformSearch<S>, cursor?: string): string;
  listingPage(payload: unknown, search: PlatformSearch<S>, cursor?: string): ApiListingPage;
  detailUrl?(candidate: VacancyCandidate): string;
  vacancy(candidate: VacancyCandidate, payload: unknown, context: SourceContext):
    Promise<VacancyInput | null> | VacancyInput | null;
  requestInit?(phase: ApiRequestPhase, candidate?: VacancyCandidate): RequestInit;
}

export interface ApiSourceOptions { readonly maxPages?: number }

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid API source ${name}.`);
}

function requestInit<S extends SourceSchema>(
  definition: ApiSourceDefinition<S>, phase: ApiRequestPhase, candidate?: VacancyCandidate,
): RequestInit {
  const supplied = definition.requestInit?.(phase, candidate) ?? {};
  const headers = new Headers(supplied.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (!headers.has('user-agent')) headers.set('user-agent', sourceUserAgent);
  return { ...supplied, headers, signal: supplied.signal ?? AbortSignal.timeout(45_000) };
}

function pageAllocations(searches: number, budget: number, maximum: number): readonly number[] {
  if (searches === 0) return [];
  const base = Math.floor(budget / searches);
  const remainder = budget % searches;
  return Object.freeze(Array.from({ length: searches }, (_, index) =>
    Math.min(maximum, base + (index < remainder ? 1 : 0))));
}

function listingInput<S extends SourceSchema>(
  definition: ApiSourceDefinition<S>, listing: ApiListing, search: PlatformSearch<S>, context: SourceContext,
): VacancyCandidateInput {
  if (!listing.title.trim()) throw new TypeError(`Source ${definition.id} returned an empty listing title.`);
  const publishedAt = listing.publishedAt === undefined ? undefined : new Date(listing.publishedAt);
  if (publishedAt && !Number.isFinite(publishedAt.getTime())) {
    throw new TypeError(`Source ${definition.id} returned an invalid listing date.`);
  }
  return {
    source: parseSourceKey(definition.id),
    sourceId: parseSourceVacancyId(listing.sourceId),
    url: context.http.sourceUrl(definition.id, listing.url),
    searchName: definition.searchName(search),
    title: listing.title.trim(),
    ...(listing.summary === undefined ? {} : { summary: listing.summary }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(listing.payload === undefined ? {} : { payload: listing.payload }),
  };
}

async function discoverApi<S extends SourceSchema>(
  definition: ApiSourceDefinition<S>, plan: SearchPlan<PlatformSearch<S>>, context: SourceContext, maximumPages: number,
) {
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
  const allocations = pageAllocations(plan.searches.length, context.limits.searchPageBudgetPerPlatform, maximumPages);
  const users = new Set<string>();
  for (const planned of plan.searches) for (const recipient of planned.recipients) users.add(recipient.userId);

  for (let searchIndex = 0; searchIndex < plan.searches.length && !collector.complete; searchIndex += 1) {
    const planned = plan.searches[searchIndex]!;
    const cursorHistory = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < allocations[searchIndex]! && !collector.complete; page += 1) {
      const payload = await context.http.fetchSourceJson(
        definition.id,
        definition.searchUrl(planned.search, cursor),
        requestInit(definition, 'listing'),
      );
      const decoded = definition.listingPage(payload, planned.search, cursor);
      if (!Array.isArray(decoded.listings)) throw new TypeError(`Source ${definition.id} returned an invalid listing page.`);
      for (const listing of decoded.listings) {
        if (collector.complete) break;
        await collector.record(listingInput(definition, listing, planned.search, context), planned.recipients);
      }
      const next = decoded.nextCursor;
      if (next === undefined || next === '' || cursorHistory.has(next)) break;
      cursorHistory.add(next);
      cursor = next;
    }
  }
  return Object.freeze({ searches: plan.searches.length, users: users.size, ...collector.result() });
}

async function normalizeApi<S extends SourceSchema>(
  definition: ApiSourceDefinition<S>, candidates: readonly VacancyCandidate[], context: SourceContext,
): Promise<Map<string, VacancyInput | null | Error>> {
  const output = new Map<string, VacancyInput | null | Error>();
  await Promise.all(candidates.map(async (candidate) => {
    try {
      const payload = definition.detailUrl
        ? await context.http.fetchSourceJson(definition.id, definition.detailUrl(candidate), requestInit(definition, 'detail', candidate))
        : candidate.payload;
      output.set(candidate.sourceId, await definition.vacancy(candidate, payload, context));
    } catch (error) {
      output.set(candidate.sourceId, error instanceof Error ? error : new Error(context.errorMessage(error)));
    }
  }));
  return output;
}

export function createApiSource<S extends SourceSchema>(
  definition: ApiSourceDefinition<S>, options: ApiSourceOptions = {},
): SourceProvider<S> {
  const maximumPages = options.maxPages ?? Number.MAX_SAFE_INTEGER;
  positiveInteger(maximumPages, 'maximum pages');
  return createSourceProvider({
    ...definition,
    discover: (plan, context) => discoverApi(definition, plan, context, maximumPages),
    normalize: (candidates, context) => normalizeApi(definition, candidates, context),
  });
}
