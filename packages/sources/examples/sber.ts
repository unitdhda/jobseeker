import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import { type ApiListing, type ApiSourceDefinition } from '@jobseeker/sources/drivers/api';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const id = 'sber';
const employer = 'Сбер';
const pageSize = 20;

export interface SberSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  employer: string;
  area: string;
  salaryFrom: number | null;
  salaryTo: number | null;
  description: string;
}

export function sberSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/public/app-candidate-public-api-gateway/api/v1/publications', 'https://rabota.sber.ru');
  url.searchParams.set('searchString', query);
  url.searchParams.set('take', String(pageSize));
  url.searchParams.set('skip', cursor ?? '0');
  return url.toString();
}

/** Sections arrive as markdown with their own headings, so joining them keeps the advert's structure. */
function sections(item: Record<string, unknown>): string {
  return [item.introduction, item.duties, item.requirements, item.conditions]
    .map(plainText).filter(Boolean).join('\n\n');
}

export function sberListingPage(payload: unknown, offset: number): { listings: Listing[]; nextCursor?: string } {
  const data = asObject(asObject(payload)?.data);
  const items = Array.isArray(data?.vacancies) ? data.vacancies : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.internalId), title = plainText(item?.title);
    if (!/^\d+$/.test(sourceId) || !title) return [];
    const area = plainText(item?.city) || plainText(item?.region);
    const company = plainText(item?.company);
    const salaryFrom = Number(item?.salary_min), salaryTo = Number(item?.salary_max);
    return [{
      // The public page routes on the trailing internal id; the slug ahead of it is decorative.
      sourceId,
      url: `https://rabota.sber.ru/search/vacancy-${sourceId}/`,
      title,
      summary: [company, plainText(item?.specialization), area].filter(Boolean).join(' · '),
      publishedAt: plainText(item?.publicationDate) || undefined,
      employer: company || employer,
      area,
      salaryFrom: salaryFrom > 0 ? salaryFrom : null,
      salaryTo: salaryTo > 0 ? salaryTo : null,
      // The listing carries the complete advert, so normalization never issues a second request.
      description: sections(item ?? {}),
    }];
  });
  const total = Number(data?.total);
  const nextOffset = offset + pageSize;
  return {
    listings,
    nextCursor: listings.length && Number.isInteger(total) && nextOffset < total ? String(nextOffset) : undefined,
  };
}

export function sberVacancyInput(candidate: VacancyCandidate,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const listing = candidate.payload as unknown as Listing | null;
  if (!listing?.title) return null;
  const description = listing.description ?? '';
  if (description.length < 20) return null;
  const hasSalary = listing.salaryFrom != null || listing.salaryTo != null;
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name: listing.title,
    employer: listing.employer || employer,
    area: listing.area || 'Не указано',
    salaryFrom: listing.salaryFrom ?? null,
    salaryTo: listing.salaryTo ?? null,
    salaryCurrency: hasSalary ? 'RUR' : null,
    salaryGross: null,
    experience: '',
    employment: '',
    schedule: '',
    workFormat: '',
    description,
    keySkills: [],
    url: validateUrl(id, candidate.url),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const sberDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'Sber Careers',
  hosts: ['rabota.sber.ru'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: (search, cursor) => sberSearchUrl(search.query, cursor),
  listingPage: (payload, _search, cursor) => sberListingPage(payload, Number(cursor ?? '0') || 0),
  vacancy: (candidate, _payload, context) => sberVacancyInput(candidate, context.http.safeVacancyUrl),
};

/** Application-owned Sber definition over the reusable paginated JSON API driver. */
export function sberSource(options: SberSourceOptions = {}) {
  return createApiSource(sberDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(sberSource({ maxPages: examplePages(api) }));
}
