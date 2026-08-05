/**
 * "Работа России" (trudvsem.ru) publishes the federal vacancy register as an open JSON API, so this adapter needs
 * neither HTML parsing nor a browser. One request returns complete postings, and normalization reuses the payload.
 */
import * as v from 'valibot';
import { errorMessage, sourcesSettings, trace } from './config.ts';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/store';
import { asObject, fetchSourceJson, hashedVacancy, htmlText, plainText, safeVacancyUrl,
  VacancySearchCollector, type JsonObject } from './http.ts';
import type { SearchPlan } from './contract.ts';
import type { SearchPlatform } from './contract.ts';

/** Federal region code; defaults to Москва, matching the default HH area. */
export function trudvsemRegion(): string {
  const raw = sourcesSettings().trudvsemRegion;
  if (!raw) return '7700000000';
  if (!/^\d{11,13}$/.test(raw)) throw new Error('TRUDVSEM_REGION must be a numeric federal region code.');
  return raw;
}

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const trudvsemSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});
export type TrudvsemSearchProfile = v.InferOutput<typeof trudvsemSearchProfileSchema>;
export type TrudvsemSearch = TrudvsemSearchProfile['searches'][number];

export const trudvsemPlatform: SearchPlatform<typeof trudvsemSearchProfileSchema> = {
  id: 'trudvsem', name: 'Работа России', hosts: ['opendata.trudvsem.ru', 'trudvsem.ru', 'www.trudvsem.ru'],
  schema: trudvsemSearchProfileSchema,
  template: () => ({
    platform: 'trudvsem', version: 1,
    purpose: 'Open federal vacancy register published by trudvsem.ru.',
    jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }] },
    capabilities: { query: 'One concise Russian role title; the register is a Russian state service', maxSearches: 8 },
    rules: [
      'Use Russian role titles only, because the register indexes Russian job names.',
      'Each query contains one role title without boolean syntax, slashes, or parentheses.',
      'Do not add location, salary, or work-format terms.',
    ],
  }),
};

export function trudvsemSearchUrl(query: string, page: number): string {
  const url = new URL(`/api/v1/vacancies/region/${trudvsemRegion()}`, 'https://opendata.trudvsem.ru');
  url.searchParams.set('text', query);
  url.searchParams.set('limit', '50');
  if (page > 1) url.searchParams.set('offset', String((page - 1) * 50));
  return url.toString();
}

export function trudvsemVacancies(payload: unknown): JsonObject[] {
  const results = asObject(asObject(payload)?.results);
  const list = Array.isArray(results?.vacancies) ? results.vacancies : [];
  return list.flatMap((entry) => {
    const vacancy = asObject(asObject(entry)?.vacancy);
    return vacancy ? [vacancy] : [];
  });
}

function salaryOf(vacancy: JsonObject): Pick<VacancyInput, 'salaryFrom' | 'salaryTo' | 'salaryCurrency' | 'salaryGross'> {
  const from = Number(vacancy.salary_min);
  const to = Number(vacancy.salary_max);
  const salaryFrom = Number.isFinite(from) && from > 0 ? from : null;
  const salaryTo = Number.isFinite(to) && to > 0 ? to : null;
  return { salaryFrom, salaryTo, salaryCurrency: salaryFrom || salaryTo ? 'RUR' : null, salaryGross: null };
}

export function trudvsemVacancyInput(vacancy: JsonObject, sourceQuery: string): VacancyInput | null {
  const sourceId = plainText(vacancy.id);
  const name = plainText(vacancy['job-name']);
  const description = htmlText(plainText(vacancy.duty));
  if (!sourceId || !name || description.length < 20) return null;
  const requirement = asObject(vacancy.requirement);
  const url = plainText(vacancy.vac_url);
  return hashedVacancy({
    source: 'trudvsem', sourceId, name,
    employer: plainText(asObject(vacancy.company)?.name) || 'Не указано',
    area: plainText(asObject(vacancy.region)?.name) || 'Не указано',
    ...salaryOf(vacancy),
    experience: (() => {
      const years = Number(requirement?.experience);
      return Number.isFinite(years) && years > 0 ? `${years} лет` : '';
    })(),
    employment: plainText(vacancy.employment), schedule: plainText(vacancy.schedule), workFormat: '',
    description, keySkills: [],
    url: url ? safeVacancyUrl('trudvsem', url) : `https://trudvsem.ru/vacancy/card/${sourceId}`,
    publishedAt: plainText(vacancy['creation-date']) || plainText(vacancy.date_modify) || new Date().toISOString(),
    sourceQuery,
  });
}

export async function scrapeTrudvsem(
  plan: SearchPlan<TrudvsemSearch>): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  const pagesPerSearch = Math.max(1, Math.min(sourcesSettings().additionalMaxPages,
    Math.floor(sourcesSettings().searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
  searches: for (const { search, recipients } of plan.searches) {
    for (let page = 1; page <= pagesPerSearch; page++) {
      const url = trudvsemSearchUrl(search.query, page);
      try {
        trace('scrape.search.request', { platform: 'trudvsem', search: search.name, query: search.query, page, url });
        const vacancies = trudvsemVacancies(await fetchSourceJson('trudvsem', url));
        trace('scrape.search.result', { platform: 'trudvsem', search: search.name, page, found: vacancies.length });
        for (const vacancy of vacancies) {
          const sourceId = plainText(vacancy.id);
          const name = plainText(vacancy['job-name']);
          if (!sourceId || !name) continue;
          const vacancyUrl = plainText(vacancy.vac_url);
          await collector.record({ source: 'trudvsem', sourceId,
            url: vacancyUrl ? safeVacancyUrl('trudvsem', vacancyUrl) : `https://trudvsem.ru/vacancy/card/${sourceId}`,
            searchName: search.name, title: name,
            summary: htmlText(plainText(vacancy.duty)).slice(0, 1_000),
            publishedAt: plainText(vacancy['creation-date']), payload: vacancy }, recipients);
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        if (!vacancies.length) break;
      } catch (error) {
        console.error(`Failed to read Работа России search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function normalizeTrudvsemCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  // The register returns complete postings during discovery, so the stored payload needs no second request.
  const vacancy = candidate.payload as JsonObject | null;
  if (!vacancy) return null;
  return trudvsemVacancyInput(vacancy, candidate.searchName);
}
