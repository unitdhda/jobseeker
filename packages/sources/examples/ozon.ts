import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import type { ApiListing, ApiSourceDefinition } from '@jobseeker/sources/drivers/api';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, htmlText, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const id = 'ozon';
const employer = 'Ozon';
const pageSize = 20;

export interface OzonSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  area: string;
  experience: string;
  employment: string;
  workFormat: string;
}

export function ozonSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/vacancy', 'https://job-api.ozon.ru');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('page', cursor ?? '1');
  return url.toString();
}

function stringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map(plainText).filter(Boolean);
}

function objectTitles(value: unknown, key = 'title'): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.[key])).filter(Boolean);
}

export function ozonListingPage(payload: unknown): { listings: Listing[]; nextCursor?: string } {
  const response = asObject(payload);
  const meta = asObject(response?.meta);
  const items = Array.isArray(response?.items) ? response.items : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.hhId), title = plainText(item?.title);
    if (!/^\d+$/.test(sourceId) || !title || item?.hidden === true) return [];
    const area = plainText(item?.city);
    const experience = plainText(item?.experience);
    const workFormat = stringList(item?.workFormat).join(', ');
    return [{
      sourceId,
      url: `https://job-api.ozon.ru/vacancy/${sourceId}`,
      title,
      summary: [plainText(item?.department), ...objectTitles(item?.professionalRoles), area, experience, workFormat]
        .filter(Boolean).join(' · '),
      area,
      experience,
      employment: plainText(item?.employment),
      workFormat,
    }];
  });
  const page = Number(meta?.page), totalPages = Number(meta?.totalPages);
  return {
    listings,
    nextCursor: Number.isInteger(page) && Number.isInteger(totalPages) && page < totalPages
      ? String(page + 1) : undefined,
  };
}

function publishedAt(value: unknown): string | null {
  const text = plainText(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text.replace(' ', 'T')}+03:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function ozonVacancyInput(candidate: VacancyCandidate, payload: unknown,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = asObject(payload);
  const listing = candidate.payload as unknown as Listing | null;
  const name = plainText(detail?.name) || listing?.title || candidate.title;
  const description = htmlText(plainText(detail?.descr));
  if (!name || description.length < 20) return null;
  const salary = asObject(detail?.salary);
  const salaryFrom = Number(salary?.from), salaryTo = Number(salary?.to);
  const hasSalary = salaryFrom > 0 || salaryTo > 0;
  const currency = plainText(salary?.currency).toUpperCase().replace('RUB', 'RUR');
  const address = asObject(detail?.address);
  const slug = plainText(detail?.slug);
  const canonicalUrl = `https://career.ozon.ru/vacancy/${encodeURIComponent(slug || candidate.sourceId)}`;
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name,
    employer,
    area: plainText(detail?.city) || plainText(address?.city) || listing?.area || 'Не указано',
    salaryFrom: salaryFrom > 0 ? salaryFrom : null,
    salaryTo: salaryTo > 0 ? salaryTo : null,
    salaryCurrency: hasSalary ? currency || null : null,
    salaryGross: hasSalary && typeof salary?.gross === 'boolean' ? salary.gross : null,
    experience: plainText(detail?.exp) || listing?.experience || '',
    employment: plainText(detail?.employment) || listing?.employment || '',
    schedule: '',
    workFormat: stringList(detail?.workFormat).join(', ') || listing?.workFormat || '',
    description,
    keySkills: objectTitles(detail?.skills, 'name').slice(0, 30),
    url: validateUrl(id, canonicalUrl),
    publishedAt: publishedAt(detail?.publishedAt) ?? candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const ozonDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'Ozon Careers',
  hosts: ['job-api.ozon.ru', 'career.ozon.ru'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: (search, cursor) => ozonSearchUrl(search.query, cursor),
  listingPage: (payload) => ozonListingPage(payload),
  detailUrl: (candidate) =>
    `https://job-api.ozon.ru/vacancy/${encodeURIComponent(candidate.sourceId)}`,
  vacancy: (candidate, payload, context) =>
    ozonVacancyInput(candidate, payload, context.http.safeVacancyUrl),
};

/** Application-owned Ozon definition over the reusable paginated JSON API driver. */
export function ozonSource(options: OzonSourceOptions = {}) {
  return createApiSource(ozonDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(ozonSource({ maxPages: examplePages(api) }));
}
