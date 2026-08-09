/**
 * Т-Банк first-party careers. The public gateway is RPC-style: POST pfpjobs/papi/getVacancies enumerates a
 * category with group-keyed pagination and no free-text search, so planned queries are matched against listing
 * titles locally. Vacancy pages embed the full structured advert in the SSR state blob, which normalization reads
 * instead of scraping the styled markup.
 */
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { JsonObject } from '@jobseeker/sources';

import { companySearchProfileSchema, companySearchTemplate } from './profile.ts';
import { asObject, createSourceProvider, examplePages, hashedVacancy, htmlText, initToolkit, plainText, postingMatchesQuery, sourceUserAgent, VacancySearchCollector, type SourceExtensionApi } from './toolkit.ts';

const id = 'tbank';
const employer = 'Т-Банк';
const origin = 'https://www.tbank.ru';
/** Category → pagination group key, as the gateway names them. */
const categories = [
  ['tcareer_it', 'it'], ['tcareer_back_office', 'back_office'], ['tcareer_work_with_clients', 'job'],
] as const;

export interface TbankSourceOptions { maxPages?: number }

export interface TbankListing extends JsonObject {
  sourceId: string;
  url: string;
  title: string;
  summary: string;
  area: string;
  workFormat: string;
  salary: string;
}

export function tbankRequestBody(category: string, group: string, offset: number): string {
  return JSON.stringify({
    filters: {
      generatedGraphQL: {
        type: 'T_CAREER', status: 'ACTIVE', searchFiasIds: [],
        includeSeoAndPcPublications: false, includeInternshipPublications: false,
        userGroup: { groups: ['Control'], type: 'SPECIFIC' },
        or: [{ category }],
      },
    },
    pagination: { [group]: { offset, isFinished: false } },
  });
}

export function tbankListings(payload: unknown, group: string):
  { listings: TbankListing[]; nextOffset?: number } {
  const body = asObject(asObject(payload)?.payload);
  const items = Array.isArray(body?.vacancies) ? body.vacancies : [];
  const listings = items.flatMap((entry): TbankListing[] => {
    const item = asObject(entry);
    const urlSlug = plainText(item?.urlSlug), title = plainText(item?.title);
    const seoSlug = plainText(item?.seoSlug) || 'vacancy';
    if (!urlSlug || !title || plainText(item?.redirectUrl)) return [];
    const area = plainText(item?.subtitle);
    const tags = (Array.isArray(item?.tags) ? item.tags : []).map(plainText).filter(Boolean);
    return [{
      sourceId: urlSlug,
      // The page routes on the trailing slug; the city and category segments are display-only.
      url: `${origin}/career/service/vacancy/moscow/${encodeURIComponent(seoSlug)}/${encodeURIComponent(urlSlug)}/`,
      title,
      summary: [plainText(item?.shortDescription), area, ...tags].filter(Boolean).join(' · '),
      area,
      workFormat: tags.join(', '),
      salary: plainText(item?.salary),
    }];
  });
  const next = asObject(asObject(body?.nextPagination)?.[group]);
  const offset = Number(next?.offset);
  return {
    listings,
    ...next?.isFinished === false && Number.isInteger(offset) ? { nextOffset: offset } : {},
  };
}

function sectionText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return htmlText(content);
  if (!Array.isArray(content)) return '';
  return content.map((entry) => {
    const item = asObject(entry);
    return [plainText(item?.title), plainText(item?.description)].filter(Boolean).join(': ');
  }).filter(Boolean).map((line) => `• ${line}`).join('\n');
}

/** Reads the vacancy out of the page's SSR state: the largest inline JSON script carries the tramvai stores. */
export function tbankVacancyFromHtml(html: string): Record<string, unknown> | null {
  const scripts = [...html.matchAll(/<script[^>]*>({".{2000,}?})<\/script>/gs)]
    .map((match) => match[1]!).sort((a, b) => b.length - a.length);
  for (const script of scripts) {
    try {
      const stores = asObject(asObject(JSON.parse(script))?.stores);
      const vacancy = asObject(asObject(stores?.vacancyDescriptionStore)?.vacancyDescription);
      if (vacancy && plainText(vacancy.title)) return vacancy;
    } catch { /* not the state blob */ }
  }
  return null;
}

export function tbankVacancyInput(candidate: VacancyCandidate, html: string,
  validateUrl: (source: string, input: string) => string): VacancyInput | null {
  const vacancy = tbankVacancyFromHtml(html);
  const listing = candidate.payload as unknown as TbankListing | null;
  if (!vacancy) return null;
  const sections = (Array.isArray(vacancy.description) ? vacancy.description : [])
    .flatMap((entry) => {
      const block = asObject(entry);
      if (!block) return [];
      const text = sectionText(block);
      if (!text) return [];
      const title = plainText(block.title);
      return [title && !/короткое описание/i.test(title) ? `${title}:\n${text}` : text];
    });
  const description = sections.join('\n\n');
  if (description.length < 20) return null;
  const salary = plainText(asObject(vacancy.salary)?.amount) || listing?.salary || '';
  const tags = (Array.isArray(vacancy.tags) ? vacancy.tags : [])
    .map((entry) => plainText(asObject(entry)?.text)).filter(Boolean);
  return hashedVacancy({
    source: id,
    sourceId: candidate.sourceId,
    name: plainText(vacancy.title) || candidate.title,
    employer,
    area: plainText(vacancy.subtitle) || listing?.area || 'Не указано',
    salaryFrom: null,
    salaryTo: null,
    salaryCurrency: null,
    salaryGross: null,
    experience: '',
    employment: '',
    schedule: salary ? `Оплата: ${salary}` : '',
    workFormat: tags.join(', ') || listing?.workFormat || '',
    description,
    keySkills: [],
    url: validateUrl(id, candidate.url),
    publishedAt: candidate.publishedAt,
    sourceQuery: candidate.searchName,
  });
}

/** Fresh T-Bank provider; register it in any createSources() collection. */
export function tbankSource(options: TbankSourceOptions = {}) {
  return createSourceProvider({
    id,
    name: 'T-Bank Careers',
    hosts: ['www.tbank.ru'],
    schema: companySearchProfileSchema,
    template: () => companySearchTemplate(id, employer),
    enumerates: true,
    async discover(plan, context) {
      const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit,
        context.recordListingCandidate);
      const pages = Math.max(1, Math.min(options.maxPages ?? 1,
        Math.floor(context.limits.searchPageBudgetPerPlatform / categories.length)));
      groups: for (const [category, group] of categories) {
        let offset = 0;
        for (let page = 1; page <= pages; page++) {
          let result: { listings: TbankListing[]; nextOffset?: number };
          try {
            context.trace('scrape.search.request', { platform: id, category, page });
            const payload = await context.http.fetchSourceJson(id, `${origin}/pfpjobs/papi/getVacancies`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json', accept: 'application/json',
                'user-agent': sourceUserAgent, origin, referer: `${origin}/career/vacancies/all/moscow/`,
              },
              body: tbankRequestBody(category, group, offset),
              signal: AbortSignal.timeout(45_000),
            });
            result = tbankListings(payload, group);
            context.trace('scrape.search.result', { platform: id, category, page, found: result.listings.length });
          } catch (error) {
            console.error(`Failed to read T-Bank ${category} page ${page}: ${context.errorMessage(error)}`);
            continue groups;
          }
          for (const listing of result.listings) {
            const planned = plan.searches.find(({ search }) => postingMatchesQuery(listing.title, search.query));
            if (!planned) continue;
            await collector.record({
              source: id, sourceId: listing.sourceId, url: context.http.safeVacancyUrl(id, listing.url),
              searchName: planned.search.name, title: listing.title, summary: listing.summary.slice(0, 1_000),
              payload: listing,
            }, planned.recipients);
            if (collector.complete) break groups;
          }
          if (result.nextOffset == null) break;
          offset = result.nextOffset;
        }
      }
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...collector.result() };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      for (const candidate of candidates) {
        try {
          const page = await context.http.fetchSourceHtml(id, candidate.url);
          results.set(candidate.sourceId,
            tbankVacancyInput(candidate, page.html, context.http.safeVacancyUrl));
        } catch (error) {
          results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return results;
    },
  });
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(tbankSource({ maxPages: examplePages(api) }));
}
