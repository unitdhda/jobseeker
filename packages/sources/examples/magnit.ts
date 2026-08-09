import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

import { type ApiListing, type ApiSourceDefinition } from '@jobseeker/sources/drivers/api';
import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createApiSource, examplePages, hashedVacancy, htmlText, initToolkit, plainText, type SourceExtensionApi } from './toolkit.ts';

const id = 'magnit';
const employer = 'Магнит Tech';

export interface MagnitSourceOptions { maxPages?: number }

interface Listing extends ApiListing {
  summary: string;
  area: string;
  workFormat: string;
  keySkills: string[];
}

export function magnitSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/api/v1/vacancy', 'https://magnit.tech');
  url.searchParams.set('search', query);
  url.searchParams.set('page', cursor ?? '1');
  return url.toString();
}

function names(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((entry) => plainText(asObject(entry)?.name)).filter(Boolean);
}

export function magnitListingPage(payload: unknown): { listings: Listing[]; nextCursor?: string } {
  const response = asObject(payload);
  const meta = asObject(response?.meta);
  const items = Array.isArray(response?.results) ? response.results : [];
  const listings = items.flatMap((entry): Listing[] => {
    const item = asObject(entry);
    const sourceId = plainText(item?.id), title = plainText(item?.title);
    if (!/^\d+$/.test(sourceId) || !title) return [];
    const area = plainText(item?.location);
    const workFormat = names(item?.work_formats).join(', ');
    return [{
      sourceId,
      url: `https://magnit.tech/vacancies/${sourceId}`,
      title,
      summary: [plainText(asObject(item?.direction)?.name), plainText(asObject(item?.speciality)?.name),
        area, workFormat].filter(Boolean).join(' · '),
      area,
      workFormat,
      keySkills: names(item?.technologies).slice(0, 30),
    }];
  });
  const page = Number(meta?.current_page);
  return {
    listings,
    nextCursor: Number.isInteger(page) && meta?.has_more_pages === true ? String(page + 1) : undefined,
  };
}

function sections(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [heading, field] of [
    ['', 'description'], ['О продукте', 'about_product'], ['Задачи', 'tasks'],
    ['Требования', 'skills'], ['Будет плюсом', 'extra_skills'], ['Мы предлагаем', 'offer'],
  ] as const) {
    const value = htmlText(plainText(detail[field]));
    if (value) parts.push(heading ? `${heading}:\n${value}` : value);
  }
  return parts.join('\n\n');
}

export function magnitVacancyInput(candidate: VacancyCandidate, payload: unknown,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const detail = asObject(asObject(payload)?.results);
  const listing = candidate.payload as unknown as Listing | null;
  if (!detail) return null;
  const name = plainText(detail.title) || listing?.title || candidate.title;
  const description = sections(detail);
  if (!name || description.length < 20) return null;
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name,
    employer,
    area: plainText(detail.location) || listing?.area || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience: '',
    employment: '',
    schedule: '',
    workFormat: names(detail.work_formats).join(', ') || listing?.workFormat || '',
    description,
    keySkills: names(detail.technologies).slice(0, 30).length
      ? names(detail.technologies).slice(0, 30) : listing?.keySkills ?? [],
    url: validateUrl(id, `https://magnit.tech/vacancies/${candidate.sourceId}`),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

const magnitDefinition: ApiSourceDefinition<typeof companySearchProfileSchema> = {
  id,
  name: 'Magnit Tech Careers',
  hosts: ['magnit.tech'],
  schema: companySearchProfileSchema,
  template: () => companySearchTemplate(id, employer),
  searchName: (search) => search.name,
  searchUrl: (search, cursor) => magnitSearchUrl(search.query, cursor),
  listingPage: (payload) => magnitListingPage(payload),
  detailUrl: (candidate) => `https://magnit.tech/api/v1/vacancy/${encodeURIComponent(candidate.sourceId)}`,
  vacancy: (candidate, payload, context) => magnitVacancyInput(candidate, payload, context.http.safeVacancyUrl),
};

/** Application-owned Magnit Tech definition over the reusable paginated JSON API driver. */
export function magnitSource(options: MagnitSourceOptions = {}) {
  return createApiSource(magnitDefinition, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(magnitSource({ maxPages: examplePages(api) }));
}
