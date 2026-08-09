import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import { type ApiListing, type ApiSourceDefinition } from '@jobseeker/sources/drivers/api';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const id = 'mts';
const employer = 'МТС';
const pageSize = 20;

export interface MtsSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  employer: string;
  area: string;
  experience: string;
  employment: string;
  workFormat: string;
  keySkills: string[];
}

export function mtsSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/api/v2/catalog/v1/vacancies', 'https://job.mts.ru');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', cursor ?? '0');
  return url.toString();
}

function titles(value: unknown, key = 'title'): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.[key])).filter(Boolean);
}

/** The catalog id addresses the API; the public page is keyed by the numeric id carried in `externalUrl`. */
export function mtsPageId(item: Record<string, unknown> | null): string {
  const external = /\/jobs\/(\d+)/.exec(plainText(item?.externalUrl))?.[1];
  return external || plainText(item?.slug) || plainText(item?.id);
}

export function mtsListingPage(payload: unknown): { listings: Listing[]; nextCursor?: string } {
  const response = asObject(payload);
  const pagination = asObject(asObject(response?.meta)?.pagination);
  const items = Array.isArray(response?.data) ? response.data : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.id), title = plainText(item?.title) || plainText(item?.displayTitle);
    const pageId = mtsPageId(item);
    if (!sourceId || !title || !pageId) return [];
    const area = titles(item?.cities).slice(0, 3).join(', ');
    const experience = plainText(asObject(item?.experience)?.title);
    const workFormat = titles(item?.workFormats).join(', ');
    return [{
      sourceId,
      url: `https://job.mts.ru/vacancy/${encodeURIComponent(pageId)}`,
      title,
      summary: [...titles(item?.professionalRoles), area, experience, workFormat].filter(Boolean).join(' · '),
      publishedAt: plainText(item?.publishedAt) || undefined,
      employer: plainText(asObject(item?.employer)?.title) || employer,
      area,
      experience,
      employment: titles(item?.employmentForms).join(', '),
      workFormat,
      keySkills: titles(item?.tags).slice(0, 30),
    }];
  });
  const page = Number(pagination?.page), size = Number(pagination?.pageSize), total = Number(pagination?.total);
  const nextOffset = page * size;
  return {
    listings,
    nextCursor: Number.isInteger(page) && Number.isInteger(size) && Number.isInteger(total)
      && size > 0 && nextOffset < total ? String(nextOffset) : undefined,
  };
}

function sections(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [heading, field] of [
    ['О проекте', 'descriptionAboutProject'], ['', 'description'],
    ['Требования', 'requirements'], ['Условия', 'conditions'],
  ] as const) {
    const value = plainText(detail[field]);
    if (value) parts.push(heading ? `${heading}:\n${value}` : value);
  }
  for (const [heading, field] of [
    ['Обязанности', 'responsibilities'], ['Мы предлагаем', 'offers'], ['Преимущества', 'advantages'],
  ] as const) {
    const values = (Array.isArray(detail[field]) ? detail[field] : [])
      .map((entry) => plainText(asObject(entry)?.title) || plainText(entry)).filter(Boolean);
    if (values.length) parts.push(`${heading}:\n${values.map((value) => `• ${value}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

export function mtsVacancyInput(candidate: VacancyCandidate, payload: unknown,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = asObject(asObject(payload)?.data);
  const listing = candidate.payload as unknown as Listing | null;
  if (!detail) return null;
  const name = plainText(detail.title) || plainText(detail.displayTitle) || listing?.title || candidate.title;
  const description = sections(detail);
  if (!name || description.length < 20) return null;
  const salary = asObject(detail.salary);
  const salaryFrom = Number(salary?.from), salaryTo = Number(salary?.to);
  const hasSalary = salaryFrom > 0 || salaryTo > 0;
  const workFormat = titles(detail.workFormats).join(', ') || listing?.workFormat
    || (detail.isRemote === true ? 'Удалённая работа' : '');
  const pageId = mtsPageId(detail);
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name,
    employer: plainText(asObject(detail.employer)?.title) || listing?.employer || employer,
    area: titles(detail.cities).slice(0, 3).join(', ') || listing?.area || 'Не указано',
    salaryFrom: salaryFrom > 0 ? salaryFrom : null,
    salaryTo: salaryTo > 0 ? salaryTo : null,
    salaryCurrency: hasSalary ? plainText(salary?.currency).toUpperCase().replace('RUB', 'RUR') || null : null,
    salaryGross: hasSalary && typeof salary?.gross === 'boolean' ? salary.gross : null,
    experience: plainText(asObject(detail.experience)?.title) || listing?.experience || '',
    employment: titles(detail.employmentForms).join(', ') || listing?.employment || '',
    schedule: '',
    workFormat,
    description,
    keySkills: titles(detail.tags).slice(0, 30).length ? titles(detail.tags).slice(0, 30) : listing?.keySkills ?? [],
    url: validateUrl(id, pageId ? `https://job.mts.ru/vacancy/${encodeURIComponent(pageId)}` : candidate.url),
    publishedAt: plainText(detail.publishedAt) || candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const mtsDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'MTS Careers',
  hosts: ['job.mts.ru'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: (search, cursor) => mtsSearchUrl(search.query, cursor),
  listingPage: (payload) => mtsListingPage(payload),
  detailUrl: (candidate) => `https://job.mts.ru/api/v2/catalog/v1/vacancies/${encodeURIComponent(candidate.sourceId)}`,
  vacancy: (candidate, payload, context) => mtsVacancyInput(candidate, payload, context.http.safeVacancyUrl),
};

/** Application-owned MTS definition over the reusable paginated JSON API driver. */
export function mtsSource(options: MtsSourceOptions = {}) {
  return createApiSource(mtsDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(mtsSource({ maxPages: examplePages(api) }));
}
