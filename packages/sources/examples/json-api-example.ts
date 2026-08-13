import type { VacancyCandidate } from '@jobseeker/engine/contracts';
import type { ApiListing, ApiListingPage } from '@jobseeker/sources/drivers/api';
import { assertToolkitInitialized, createApiSource } from './toolkit.ts';
import { textSearchProfileSchema, textSearchTemplate, type TextSearch } from './profile.ts';
import type { NormalizedApiFields } from './api-example.ts';
import { apiVacancy } from './api-example.ts';

export interface JsonApiExampleDefinition {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly string[];
  readonly language: string;
  searchUrl(search: TextSearch, cursor?: string): string;
  listingPage(payload: unknown, search: TextSearch, cursor?: string): ApiListingPage;
  detailUrl?(candidate: VacancyCandidate): string;
  fields(candidate: VacancyCandidate, payload: unknown): NormalizedApiFields;
  requestInit?(phase: 'listing' | 'detail', candidate?: VacancyCandidate): RequestInit;
}

export function jsonApiExampleSource(
  definition: JsonApiExampleDefinition,
  options: { readonly maxPages?: number } = {},
) {
  assertToolkitInitialized();
  return createApiSource({
    id: definition.id, name: definition.name, hosts: definition.hosts,
    schema: textSearchProfileSchema,
    template: () => textSearchTemplate(definition.id, definition.name, definition.language),
    searchName: (search) => search.name,
    searchUrl: definition.searchUrl,
    listingPage: definition.listingPage,
    ...(definition.detailUrl ? { detailUrl: definition.detailUrl } : {}),
    ...(definition.requestInit ? { requestInit: definition.requestInit } : {}),
    vacancy: (candidate, payload) => apiVacancy(candidate, definition.fields(candidate, payload)),
  }, options);
}

export function listing(
  sourceId: string, url: string, title: string,
  options: { readonly summary?: string; readonly publishedAt?: string; readonly payload?: unknown } = {},
): ApiListing {
  return { sourceId, url, title, ...options };
}

export default function register(): void {}
