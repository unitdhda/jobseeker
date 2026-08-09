import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import { type ApiListing, type ApiSourceDefinition } from '@jobseeker/sources/drivers/api';

import { companySearchProfileSchema, companySearchTemplate, type CompanySearch } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, htmlText, initToolkit, plainText, postingMatchesQuery, type SourceExtensionApi } from './toolkit.ts';

const id = 'selectel';
const employer = 'Selectel';

export interface SelectelSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  area: string;
  workFormat: string;
}

/** The API has no text search, so the whole small catalogue is fetched once and matched by title locally. */
export function selectelSearchUrl(): string {
  return 'https://api.selectel.ru/proxy/public/employee/api/public/vacancies?per_page=1000';
}

export function selectelListingPage(payload: unknown, search: CompanySearch): { listings: Listing[] } {
  const items = Array.isArray(asObject(payload)?.items) ? (asObject(payload)!.items as unknown[]) : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.id), title = plainText(item?.title);
    if (!/^\d+$/.test(sourceId) || !title || !postingMatchesQuery(title, search.query)) return [];
    const area = plainText(asObject(item?.city)?.name);
    const workFormat = item?.is_remote_available === true ? 'Удалённо доступно' : '';
    return [{
      sourceId,
      url: `https://selectel.ru/careers/all/vacancy/${sourceId}/`,
      title,
      summary: [plainText(asObject(item?.tag)?.description), area,
        plainText(asObject(item?.timetable_mode)?.name), workFormat].filter(Boolean).join(' · '),
      publishedAt: plainText(item?.published_at) || undefined,
      area,
      workFormat,
    }];
  });
  return { listings };
}

export function selectelVacancyInput(candidate: VacancyCandidate, payload: unknown,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = asObject(payload);
  const listing = candidate.payload as unknown as Listing | null;
  if (!detail) return null;
  const name = plainText(detail.title) || listing?.title || candidate.title;
  const description = [htmlText(plainText(detail.short_desc)), htmlText(plainText(detail.detailed_desc)),
    htmlText(plainText(detail.conditions))].filter(Boolean).join('\n\n');
  if (!name || description.length < 20) return null;
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name,
    employer,
    area: plainText(asObject(detail.city)?.name) || listing?.area || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience: '',
    employment: plainText(asObject(detail.timetable_mode)?.name),
    schedule: '',
    workFormat: detail.is_remote_available === true ? 'Удалённо доступно' : listing?.workFormat || '',
    description,
    keySkills: [],
    url: validateUrl(id, `https://selectel.ru/careers/all/vacancy/${candidate.sourceId}/`),
    publishedAt: plainText(detail.published_at) || candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const selectelDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'Selectel Careers',
  hosts: ['api.selectel.ru', 'selectel.ru'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: () => selectelSearchUrl(),
  listingPage: (payload, search) => selectelListingPage(payload, search),
  detailUrl: (candidate) =>
    `https://api.selectel.ru/proxy/public/employee/api/public/vacancies/${encodeURIComponent(candidate.sourceId)}`,
  vacancy: (candidate, payload, context) => selectelVacancyInput(candidate, payload, context.http.safeVacancyUrl),
};

/** Application-owned Selectel definition over the reusable paginated JSON API driver. */
export function selectelSource(options: SelectelSourceOptions = {}) {
  return createApiSource(selectelDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(selectelSource({ maxPages: examplePages(api) }));
}
