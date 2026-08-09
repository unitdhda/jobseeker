import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import type { ApiListing, ApiSourceDefinition } from '@jobseeker/sources/drivers/api';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const id = 'rwb';
const employer = 'RWB (Wildberries & Russ)';
const pageSize = 20;

export interface RwbSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  area: string;
  experience: string;
  employment: string;
  workFormat: string;
}

export function rwbSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/crm-api/api/v1/pub/vacancies', 'https://career.rwb.ru');
  url.searchParams.set('title', query);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', cursor ?? '0');
  return url.toString();
}

function objectTitles(value: unknown, key = 'title'): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.[key])).filter(Boolean);
}

export function rwbListingPage(payload: unknown): { listings: Listing[]; nextCursor?: string } {
  const response = asObject(payload);
  const data = asObject(response?.data);
  const range = asObject(data?.range);
  const items = Array.isArray(data?.items) ? data.items : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.id), title = plainText(item?.name);
    if (!/^\d+$/.test(sourceId) || !title) return [];
    const workFormats = objectTitles(item?.employment_types);
    const area = plainText(item?.city_title);
    const experience = plainText(item?.experience_type_title);
    return [{
      sourceId,
      url: `https://career.rwb.ru/vacancies/${sourceId}`,
      title,
      summary: [plainText(item?.direction_title), plainText(item?.direction_role_title), area, experience,
        ...workFormats].filter(Boolean).join(' · '),
      area,
      experience,
      employment: '',
      workFormat: workFormats.join(', '),
    }];
  });
  const offset = Number(range?.offset), count = Number(range?.count), limit = Number(range?.limit);
  const nextOffset = offset + limit;
  return {
    listings,
    nextCursor: Number.isInteger(offset) && Number.isInteger(count) && Number.isInteger(limit)
      && limit > 0 && nextOffset < count ? String(nextOffset) : undefined,
  };
}

function textSections(detail: Record<string, unknown>): string {
  const sections: string[] = [];
  const description = plainText(detail.description);
  if (description) sections.push(description);
  for (const [heading, field] of [
    ['Обязанности', 'duties_arr'], ['Требования', 'requirements_arr'], ['Условия', 'conditions_arr'],
  ] as const) {
    const values = (Array.isArray(detail[field]) ? detail[field] : []).map(plainText).filter(Boolean);
    if (values.length) sections.push(`${heading}:\n${values.map((value) => `• ${value}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

export function rwbVacancyInput(candidate: VacancyCandidate, payload: unknown,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const response = asObject(payload);
  const detail = asObject(response?.data);
  const listing = candidate.payload as unknown as Listing | null;
  if (!detail) return null;
  const name = plainText(detail.name) || listing?.title || candidate.title;
  const description = textSections(detail);
  if (!name || description.length < 20) return null;
  const salaryFrom = Number(detail.salary_from);
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name,
    employer,
    area: plainText(detail.office_location_city_title) || listing?.area || 'Не указано',
    salaryFrom: salaryFrom > 0 ? salaryFrom : null,
    salaryTo: null,
    salaryCurrency: salaryFrom > 0 ? 'RUR' : null,
    salaryGross: null,
    experience: plainText(detail.experience_type_title) || listing?.experience || '',
    employment: listing?.employment || '',
    schedule: '',
    workFormat: objectTitles(detail.employment_types_list).join(', ') || listing?.workFormat || '',
    description,
    keySkills: objectTitles(detail.skill_types_list, 'name').slice(0, 30),
    url: validateUrl(id, `https://career.rwb.ru/vacancies/${candidate.sourceId}`),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const rwbDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'RWB Careers',
  hosts: ['career.rwb.ru'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: (search, cursor) => rwbSearchUrl(search.query, cursor),
  listingPage: (payload) => rwbListingPage(payload),
  detailUrl: (candidate) =>
    `https://career.rwb.ru/crm-api/api/v1/pub/vacancies/${encodeURIComponent(candidate.sourceId)}`,
  vacancy: (candidate, payload, context) =>
    rwbVacancyInput(candidate, payload, context.http.safeVacancyUrl),
  requestInit: () => ({
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://career.rwb.ru/vacancies',
    },
  }),
};

/** Application-owned RWB definition over the reusable paginated JSON API driver. */
export function rwbSource(options: RwbSourceOptions = {}) {
  return createApiSource(rwbDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(rwbSource({ maxPages: examplePages(api) }));
}
