import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import type { ApiListing, ApiSourceDefinition } from '@jobseeker/sources/drivers/api';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, htmlText, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const id = 'yadro';
const employer = 'YADRO';
const pageSize = 20;

export interface YadroSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  area: string;
  experience: string;
  workFormat: string;
  keySkills: string[];
  description: string;
}

export function yadroSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/api/v1/vacancies/', 'https://careers.yadro.com');
  url.searchParams.set('search', query);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', cursor ?? '0');
  return url.toString();
}

function names(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.name)).filter(Boolean);
}

export function yadroListingPage(payload: unknown): { listings: Listing[]; nextCursor?: string } {
  const response = asObject(payload);
  const items = Array.isArray(response?.results) ? response.results : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.id), slug = plainText(item?.slug), title = plainText(item?.title);
    if (!/^\d+$/.test(sourceId) || !slug || !title) return [];
    const area = names(item?.city).join(', ');
    const experience = names(item?.grade).join(', ');
    const workFormat = names(item?.empl).join(', ');
    return [{
      sourceId,
      url: `https://careers.yadro.com/vacancy/${encodeURIComponent(slug)}`,
      title,
      summary: [plainText(asObject(item?.direction)?.name), plainText(asObject(item?.specialization)?.name),
        plainText(asObject(item?.team)?.name), area, experience, workFormat].filter(Boolean).join(' · '),
      area,
      experience,
      workFormat,
      keySkills: names(item?.skill).slice(0, 30),
      // The listing carries the complete advert, so normalization never issues a second request.
      description: plainText(item?.description),
    }];
  });
  return { listings, ...paginate(response, listings.length) };
}

/** The API's `next` link advertises a plain-http origin, so only its offset is reused on the HTTPS origin. */
function paginate(response: Record<string, unknown> | null, found: number): { nextCursor?: string } {
  const count = Number(response?.count);
  const next = plainText(response?.next);
  if (!next || !Number.isInteger(count) || !found) return {};
  try {
    const offset = Number(new URL(next, 'https://careers.yadro.com').searchParams.get('offset'));
    return Number.isInteger(offset) && offset < count ? { nextCursor: String(offset) } : {};
  } catch { return {}; }
}

export function yadroVacancyInput(candidate: VacancyCandidate,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const listing = candidate.payload as unknown as Listing | null;
  if (!listing?.title) return null;
  const description = htmlText(listing.description ?? '');
  if (description.length < 20) return null;
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name: listing.title,
    employer,
    area: listing.area || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience: listing.experience || '',
    employment: '',
    schedule: '',
    workFormat: listing.workFormat || '',
    description,
    keySkills: listing.keySkills ?? [],
    url: validateUrl(id, candidate.url),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const yadroDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'YADRO Careers',
  hosts: ['careers.yadro.com'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: (search, cursor) => yadroSearchUrl(search.query, cursor),
  listingPage: (payload) => yadroListingPage(payload),
  vacancy: (candidate, _payload, context) => yadroVacancyInput(candidate, context.http.safeVacancyUrl),
};

/** Application-owned YADRO definition over the reusable paginated JSON API driver. */
export function yadroSource(options: YadroSourceOptions = {}) {
  return createApiSource(yadroDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(yadroSource({ maxPages: examplePages(api) }));
}
