import * as v from 'valibot';
import {
  parseSourceKey,
  parseSourceVacancyId,
  type VacancyCandidate,
  type VacancyInput,
} from '@jobseeker/engine/contracts';
import type { PlatformValidationTemplate, SearchPlan, SearchPlatform } from '../contract.ts';
import type { SourceContext } from '../context.ts';
import { asObject, hashedVacancy, htmlText, plainText, VacancySearchCollector, type JsonObject } from '../http.ts';
import { createSourceProvider } from '../sources.ts';

export const atsProviders = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export type AtsProvider = typeof atsProviders[number];
const providerSet = new Set<string>(atsProviders);
const slugPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;

export function configuredBoards(entries: readonly string[] = []): Record<AtsProvider, string[]> {
  const output: Record<AtsProvider, string[]> = { greenhouse: [], lever: [], ashby: [], smartrecruiters: [] };
  for (const entry of entries) {
    const parts = entry.split(':');
    if (parts.length !== 2 || !providerSet.has(parts[0]!) || !slugPattern.test(parts[1]!)) {
      throw new TypeError(`Invalid ATS board declaration: ${entry}.`);
    }
    const provider = parts[0] as AtsProvider;
    if (!output[provider].includes(parts[1]!)) output[provider].push(parts[1]!);
  }
  return output;
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

export const atsHosts = [
  'boards-api.greenhouse.io', 'job-boards.greenhouse.io',
  'api.lever.co', 'jobs.lever.co',
  'api.ashbyhq.com', 'jobs.ashbyhq.com',
  'api.smartrecruiters.com', 'jobs.smartrecruiters.com',
] as const;

export interface AtsSourceDefinition {
  readonly id: string;
  readonly name: string;
  readonly hosts?: readonly string[];
  template?(): PlatformValidationTemplate;
}

export function atsPlatform(definition: AtsSourceDefinition): SearchPlatform<typeof atsSearchProfileSchema> {
  return Object.freeze({
    id: definition.id, name: definition.name, schema: atsSearchProfileSchema,
    hosts: definition.hosts ?? atsHosts, enumerates: true,
    template: definition.template ?? (() => ({
      platform: definition.id, version: 1, purpose: 'Generate bounded ATS title searches.',
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'role title' }] },
      capabilities: { maxSearches: 8, query: 'One concise role title matched locally against posting titles.' },
      rules: ['Return at most 8 searches.', 'Use one role title per query.', 'Do not include location or salary terms.'],
    })),
  });
}

export interface AtsBoardPosting {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly employer: string;
  readonly location: string;
  readonly publishedAt: string;
  readonly employment: string;
  readonly remote: boolean;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is JsonObject => item !== null) : [];
}
function text(value: unknown): string { return htmlText(plainText(value)); }
function isoDate(value: unknown): string {
  const date = new Date(plainText(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
function locationName(value: unknown): string {
  const object = asObject(value);
  return plainText(object?.name ?? object?.location ?? value);
}

function greenhouse(slug: string, payload: unknown): AtsBoardPosting[] {
  return objects(asObject(payload)?.jobs).flatMap((job) => {
    const id = plainText(job.id); const title = plainText(job.title);
    if (!id || !title) return [];
    return [{ sourceId: `greenhouse:${slug}:${id}`,
      url: `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}`,
      title, description: text(job.content), employer: slug, location: locationName(job.location),
      publishedAt: isoDate(job.updated_at), employment: '', remote: /remote/iu.test(locationName(job.location)) }];
  });
}
function lever(slug: string, payload: unknown): AtsBoardPosting[] {
  return objects(payload).flatMap((job) => {
    const id = plainText(job.id); const title = plainText(job.text);
    if (!id || !title) return [];
    const categories = asObject(job.categories);
    const description = [job.descriptionPlain, job.description, ...objects(job.lists).map((item) => item.content)]
      .map(text).filter(Boolean).join('\n');
    const location = plainText(categories?.location);
    return [{ sourceId: `lever:${slug}:${id}`, url: `https://jobs.lever.co/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      title, description, employer: slug, location, publishedAt: isoDate(job.createdAt),
      employment: plainText(categories?.commitment), remote: /remote/iu.test(location) }];
  });
}
function ashby(slug: string, payload: unknown): AtsBoardPosting[] {
  return objects(asObject(payload)?.jobs).flatMap((job) => {
    const id = plainText(job.id ?? job.jobUrl?.toString().split('/').at(-1)); const title = plainText(job.title);
    if (!id || !title) return [];
    const location = plainText(job.location);
    return [{ sourceId: `ashby:${slug}:${id}`, url: `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      title, description: text(job.descriptionPlain ?? job.descriptionHtml), employer: slug, location,
      publishedAt: isoDate(job.publishedAt), employment: plainText(job.employmentType),
      remote: Boolean(job.isRemote) || /remote/iu.test(location) }];
  });
}
function smartListing(slug: string, payload: unknown): AtsBoardPosting[] {
  return objects(asObject(payload)?.content).flatMap((job) => {
    const id = plainText(job.id); const title = plainText(job.name);
    if (!id || !title) return [];
    const location = asObject(job.location);
    return [{ sourceId: `smartrecruiters:${slug}:${id}`,
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      title, description: '', employer: plainText(asObject(job.company)?.name) || slug,
      location: [location?.city, location?.region, location?.country].map(plainText).filter(Boolean).join(', '),
      publishedAt: isoDate(job.releasedDate), employment: plainText(asObject(job.typeOfEmployment)?.label), remote: false }];
  });
}
function smartSection(value: unknown): string {
  const section = asObject(value);
  return text(section?.text ?? section?.html ?? value);
}

function smartDetail(base: AtsBoardPosting, payload: unknown): AtsBoardPosting {
  const detail = asObject(payload) ?? {};
  const description = asObject(asObject(detail.jobAd)?.sections);
  return { ...base,
    description: [description?.jobDescription, description?.qualifications, description?.additionalInformation]
      .map(smartSection).filter(Boolean).join('\n'),
    remote: /remote/iu.test(`${base.location} ${plainText(detail.workLocation)}`),
  };
}

function boardUrl(provider: AtsProvider, slug: string): string {
  switch (provider) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
    case 'smartrecruiters': return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`;
  }
}

export async function readBoard(
  sourceId: string, provider: AtsProvider, slug: string, context: SourceContext,
): Promise<AtsBoardPosting[]> {
  const payload = await context.http.fetchSourceJson(sourceId, boardUrl(provider, slug));
  switch (provider) {
    case 'greenhouse': return greenhouse(slug, payload);
    case 'lever': return lever(slug, payload);
    case 'ashby': return ashby(slug, payload);
    case 'smartrecruiters': return smartListing(slug, payload);
  }
}

export async function smartRecruitersDescription(
  sourceId: string, slug: string, id: string, posting: AtsBoardPosting, context: SourceContext,
): Promise<AtsBoardPosting> {
  const payload = await context.http.fetchSourceJson(sourceId,
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`);
  return smartDetail(posting, payload);
}

function significantWords(query: string): readonly string[] {
  return query.toLocaleLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu) ?? [];
}
export function postingMatchesQuery(title: string, query: string): boolean {
  const normalized = title.toLocaleLowerCase();
  const words = significantWords(query);
  return words.length > 0 && words.every((word) => normalized.includes(word));
}

export async function scrapeAts(
  sourceId: string, plan: SearchPlan<AtsSearch>, context: SourceContext, entries: readonly string[],
) {
  const boards = configuredBoards(entries);
  const collector = new VacancySearchCollector(context.limits.searchNewVacancyLimit, context.recordListingCandidate);
  for (const provider of atsProviders) {
    for (const slug of boards[provider]) {
      if (collector.complete) break;
      let postings = await readBoard(sourceId, provider, slug, context);
      for (let posting of postings) {
        if (collector.complete) break;
        const matches = plan.searches.filter(({ search }) => postingMatchesQuery(posting.title, search.query));
        if (matches.length === 0) continue;
        if (provider === 'smartrecruiters') {
          const id = posting.sourceId.split(':').at(-1)!;
          posting = await smartRecruitersDescription(sourceId, slug, id, posting, context);
        }
        const recipients = matches.flatMap(({ recipients }) => recipients);
        await collector.record({ source: parseSourceKey(sourceId), sourceId: parseSourceVacancyId(posting.sourceId),
          url: context.http.sourceUrl(sourceId, posting.url), searchName: matches[0]!.search.name,
          title: posting.title, ...(posting.publishedAt ? { publishedAt: new Date(posting.publishedAt) } : {}), payload: posting }, recipients);
      }
    }
  }
  return collector.result();
}

export async function normalizeAtsCandidate(sourceId: string, candidate: VacancyCandidate): Promise<VacancyInput | null> {
  const posting = candidate.payload as AtsBoardPosting | undefined;
  if (!posting?.title || posting.description.length < 20) return null;
  return hashedVacancy({ source: parseSourceKey(sourceId), sourceId: candidate.sourceId, name: posting.title,
    employer: posting.employer || 'Не указано', area: posting.location || 'Не указано', salary: null,
    experience: { kind: 'unspecified' }, employment: posting.employment ? 'other' : 'unspecified', schedule: 'unspecified',
    workFormat: posting.remote ? 'remote' : 'unspecified', description: posting.description, keySkills: [],
    url: candidate.url, publishedAt: posting.publishedAt ? new Date(posting.publishedAt) : candidate.publishedAt,
    sourceQuery: candidate.searchName });
}

export interface AtsSourceOptions { readonly boards?: readonly string[] }
export function createAtsSource(definition: AtsSourceDefinition, options: AtsSourceOptions = {}) {
  const platform = atsPlatform(definition);
  const boardEntries = Object.freeze([...(options.boards ?? [])]);
  configuredBoards(boardEntries);
  return createSourceProvider({ ...platform,
    async discover(plan, context) {
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...await scrapeAts(definition.id, plan, context, boardEntries) };
    },
    async normalize(candidates) {
      const results = new Map<string, VacancyInput | null | Error>();
      await Promise.all(candidates.map(async (candidate) => {
        try { results.set(candidate.sourceId, await normalizeAtsCandidate(definition.id, candidate)); }
        catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
      }));
      return results;
    },
  });
}
