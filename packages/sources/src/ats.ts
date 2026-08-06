/**
 * Applicant-tracking-system boards. Company career pages are overwhelmingly hosted on a handful of ATS products
 * that publish the same board as public JSON, so one adapter per product covers every company on it. Discovery
 * lists a board and keeps the postings whose title matches a CV-derived query; there is no server-side search.
 */
import * as v from 'valibot';
import { errorMessage, sourcesSettings, trace } from './config.ts';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import { asObject, fetchSourceJson, hashedVacancy, htmlText, plainText, safeVacancyUrl,
  VacancySearchCollector, type JsonObject } from './http.ts';
import type { SearchPlan } from './contract.ts';
import type { SearchPlatform } from './contract.ts';

export const atsProviders = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export type AtsProvider = typeof atsProviders[number];

/**
 * Boards are configured rather than discovered: an ATS exposes no directory of its customers, and an unknown slug
 * is indistinguishable from a private board. Name boards through `ATS_BOARDS` as `provider:slug` entries.
 *
 * No board ships by default. The list used to carry US tech companies (stripe, databricks, netflix and the like),
 * which matched nothing this bot searches for and produced repeated 404s as those companies left their ATS. Until
 * boards worth reading are named, ATS discovery reads nothing and the Russian-market sources cover the search.
 */
const defaultBoards: Record<AtsProvider, string[]> = {
  greenhouse: [], lever: [], ashby: [], smartrecruiters: [],
};

export function configuredBoards(entries: readonly string[] = sourcesSettings().atsBoards): Record<AtsProvider, string[]> {
  const raw = entries;
  if (!raw.length) return defaultBoards;
  const boards: Record<AtsProvider, string[]> = { greenhouse: [], lever: [], ashby: [], smartrecruiters: [] };
  for (const entry of raw) {
    const [provider, slug] = entry.split(':');
    if (!provider || !slug) throw new Error(`ATS_BOARDS entry must be provider:slug, got ${entry}`);
    if (!atsProviders.includes(provider as AtsProvider)) throw new Error(`Unknown ATS provider: ${provider}`);
    boards[provider as AtsProvider].push(slug);
  }
  return boards;
}

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const atsSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});
export type AtsSearchProfile = v.InferOutput<typeof atsSearchProfileSchema>;
export type AtsSearch = AtsSearchProfile['searches'][number];

export const atsPlatform: SearchPlatform<typeof atsSearchProfileSchema> = {
  id: 'ats', name: 'Company ATS boards', schema: atsSearchProfileSchema,
  // One adapter spans several ATS products, so both their APIs and the public posting pages they link to are listed.
  hosts: [
    'boards-api.greenhouse.io', 'boards.greenhouse.io', 'job-boards.greenhouse.io',
    'api.lever.co', 'jobs.lever.co',
    'api.ashbyhq.com', 'jobs.ashbyhq.com',
    'api.smartrecruiters.com', 'jobs.smartrecruiters.com',
  ],
  // A board is read whole and matched by title, so one read serves every user's searches at once.
  enumerates: true,
  template: () => ({
    platform: 'ats', version: 1,
    purpose: 'Public applicant-tracking boards published by individual companies (Greenhouse, Lever, Ashby, SmartRecruiters).',
    jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }] },
    capabilities: {
      query: 'One concise English role title; boards are matched by title text, not by a search engine',
      maxSearches: 8,
    },
    rules: [
      'Use English role titles because these boards are predominantly English.',
      'Each query contains one role title without boolean syntax, slashes, or parentheses.',
      'Prefer widely used titles over company-specific ones, because matching is on the posting title.',
      'Do not add location, seniority punctuation, salary, or work-format terms.',
    ],
  }),
};

interface BoardPosting {
  sourceId: string; url: string; title: string; description: string; employer: string;
  location: string; publishedAt: string; employment: string; remote: boolean;
}

function textOf(value: unknown): string { return htmlText(plainText(value)); }

function greenhousePostings(slug: string, payload: JsonObject): BoardPosting[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.flatMap((entry) => {
    const job = asObject(entry); if (!job) return [];
    const id = plainText(job.id); if (!id) return [];
    return [{
      // `absolute_url` often points at the company's own careers domain, which is outside the source allowlist,
      // so the canonical board address is used instead.
      sourceId: `greenhouse:${slug}:${id}`, url: `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}/jobs/${id}`,
      title: plainText(job.title), description: textOf(job.content),
      employer: plainText(asObject(job.company)?.name) || slug,
      location: plainText(asObject(job.location)?.name),
      // `updated_at` moves whenever the advert is edited, so the first publication is the age that matters.
      publishedAt: plainText(job.first_published) || plainText(job.updated_at),
      employment: '', remote: /remote/i.test(plainText(asObject(job.location)?.name)),
    }];
  });
}

function leverPostings(slug: string, payload: unknown): BoardPosting[] {
  const jobs = Array.isArray(payload) ? payload : [];
  return jobs.flatMap((entry) => {
    const job = asObject(entry); if (!job) return [];
    const id = plainText(job.id); if (!id) return [];
    const categories = asObject(job.categories);
    const created = Number(job.createdAt);
    return [{
      sourceId: `lever:${slug}:${id}`, url: plainText(job.hostedUrl) || plainText(job.applyUrl),
      title: plainText(job.text), description: textOf(job.descriptionPlain) || textOf(job.description),
      employer: slug, location: plainText(categories?.location),
      publishedAt: Number.isFinite(created) ? new Date(created).toISOString() : '',
      employment: plainText(categories?.commitment),
      remote: /remote/i.test(plainText(categories?.location) + plainText(job.workplaceType)),
    }];
  });
}

function ashbyPostings(slug: string, payload: JsonObject): BoardPosting[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.flatMap((entry) => {
    const job = asObject(entry); if (!job) return [];
    const id = plainText(job.id); if (!id) return [];
    return [{
      sourceId: `ashby:${slug}:${id}`, url: plainText(job.jobUrl) || plainText(job.applyUrl),
      title: plainText(job.title), description: textOf(job.descriptionPlain) || textOf(job.descriptionHtml),
      employer: plainText(job.organizationName) || slug, location: plainText(job.location),
      publishedAt: plainText(job.publishedAt), employment: plainText(job.employmentType),
      remote: job.isRemote === true,
    }];
  });
}

function smartRecruitersPostings(slug: string, payload: JsonObject): BoardPosting[] {
  const jobs = Array.isArray(payload.content) ? payload.content : [];
  return jobs.flatMap((entry) => {
    const job = asObject(entry); if (!job) return [];
    const id = plainText(job.id); if (!id) return [];
    const location = asObject(job.location);
    const city = plainText(location?.city); const country = plainText(location?.country);
    return [{
      sourceId: `smartrecruiters:${slug}:${id}`,
      // The posting API returns ids; the public posting page is the stable canonical address.
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      title: plainText(job.name), description: '', employer: plainText(asObject(job.company)?.name) || slug,
      location: [city, country].filter(Boolean).join(', '), publishedAt: plainText(job.releasedDate),
      employment: plainText(asObject(job.typeOfEmployment)?.label), remote: location?.remote === true,
    }];
  });
}

function boardUrl(provider: AtsProvider, slug: string): string {
  const encoded = encodeURIComponent(slug);
  if (provider === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${encoded}/jobs?content=true`;
  if (provider === 'lever') return `https://api.lever.co/v0/postings/${encoded}?mode=json`;
  if (provider === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${encoded}?includeCompensation=true`;
  return `https://api.smartrecruiters.com/v1/companies/${encoded}/postings?limit=100`;
}

export async function readBoard(provider: AtsProvider, slug: string): Promise<BoardPosting[]> {
  const payload = await fetchSourceJson('ats', boardUrl(provider, slug));
  if (provider === 'lever') return leverPostings(slug, payload);
  const object = asObject(payload);
  if (!object) throw new Error(`${provider} board ${slug} returned an unexpected payload`);
  if (provider === 'greenhouse') return greenhousePostings(slug, object);
  if (provider === 'ashby') return ashbyPostings(slug, object);
  return smartRecruitersPostings(slug, object);
}

/**
 * SmartRecruiters' list endpoint carries no advert text, so a matched posting is completed from its detail
 * endpoint. Only matched postings are fetched, keeping this to a handful of requests per cycle.
 */
export async function smartRecruitersDescription(slug: string, id: string): Promise<string> {
  const payload = asObject(await fetchSourceJson('ats',
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`));
  const sections = asObject(asObject(payload?.jobAd)?.sections);
  const parts = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((key) => textOf(asObject(sections?.[key])?.text)).filter(Boolean);
  return parts.join('\n\n');
}

/** Title matching stands in for the server-side search these boards do not offer. */
export function postingMatchesQuery(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((word) => word.length > 2);
  if (!words.length) return false;
  const haystack = title.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export async function scrapeAts(plan: SearchPlan<AtsSearch>): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  if (!plan.searches.length) return collector.result();
  const boards = configuredBoards();
  for (const provider of atsProviders) {
    for (const slug of boards[provider]) {
      if (collector.complete) return collector.result();
      let postings: BoardPosting[];
      try {
        postings = await readBoard(provider, slug);
        trace('scrape.search.result', { platform: 'ats', provider, slug, found: postings.length });
      } catch (error) {
        console.error(`Failed to read ${provider} board ${slug}: ${errorMessage(error)}`);
        continue;
      }
      for (const posting of postings) {
        const planned = plan.searches.find((entry) => postingMatchesQuery(posting.title, entry.search.query));
        if (!planned || !posting.url || !posting.title) continue;
        if (provider === 'smartrecruiters' && !posting.description) {
          const id = posting.sourceId.split(':').at(-1) ?? '';
          posting.description = await smartRecruitersDescription(slug, id)
            .catch((error) => { console.error(`Failed to read SmartRecruiters posting ${id}: ${errorMessage(error)}`); return ''; });
        }
        await collector.record({ source: 'ats', sourceId: posting.sourceId, url: safeVacancyUrl('ats', posting.url),
          searchName: planned.search.name, title: posting.title, summary: posting.description.slice(0, 1_000),
          publishedAt: posting.publishedAt, payload: posting as unknown as JsonObject }, planned.recipients);
        if (collector.complete) return collector.result();
      }
    }
  }
  return collector.result();
}

export async function normalizeAtsCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  // Board payloads are already complete, so normalization does not re-fetch a page that may need a browser.
  const posting = candidate.payload as unknown as BoardPosting | null;
  if (!posting?.title) return null;
  const description = posting.description || posting.title;
  if (description.length < 20) return null;
  return hashedVacancy({
    source: 'ats', sourceId: candidate.sourceId, name: posting.title, employer: posting.employer || 'Не указано',
    area: posting.location || 'Не указано', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null,
    experience: '', employment: posting.employment ?? '', schedule: '', workFormat: posting.remote ? 'remote' : '',
    description, keySkills: [], url: candidate.url,
    publishedAt: posting.publishedAt || new Date().toISOString(), sourceQuery: candidate.searchName,
  });
}
