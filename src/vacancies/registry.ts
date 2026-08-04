import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import type { VacancyCandidate, VacancyInput } from '../database.ts';

export interface PlatformValidationTemplate {
  platform: string;
  version: number;
  purpose: string;
  jsonShape: unknown;
  capabilities: Record<string, unknown>;
  rules: string[];
}

export interface SearchPlatform<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> {
  id: string;
  name: string;
  schema: S;
  template(): PlatformValidationTemplate;
  /** The platform lists everything it has whatever the query, so its plan is one job covering every cluster. */
  enumerates?: boolean;
  /** The platform accepts boolean text, so a cluster of equivalent queries becomes one OR search. */
  mergeText?: 'or';
}

export type PlatformProfile<P extends SearchPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>> =
  InferOutput<P['schema']>;

export interface PlatformDiscoveryResult { searches: number; users: number; seen: number; discovered: number }
type PlatformSearch<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> =
  InferOutput<S> extends { searches: readonly (infer T)[] } ? T : never;
export interface VacancyPlatform<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
}

import * as v from 'valibot';
import { config } from '../config.ts';
import { AdaptiveTaskPool } from '../concurrency.ts';
import { normalizeAdditionalCandidate, scrapeHabr, scrapeRabota } from './additional.ts';
import { normalizeHhCandidates, scrapeHh } from './hh.ts';
import { hhPlatform } from './hh.ts';
import { habrPlatform, rabotaPlatform } from './additional.ts';
import { hireHiPlatform, normalizeHireHiCandidate, scrapeHireHi } from './hirehi.ts';
import { atsPlatform, normalizeAtsCandidate, scrapeAts } from './ats.ts';
import { boardPlatform, normalizeJsonLdCandidate, scrapeJsonLdBoard, type JsonLdBoardId } from './boards.ts';
import { normalizeTrudvsemCandidate, scrapeTrudvsem, trudvsemPlatform } from './trudvsem.ts';
import { planPlatformSearches, type SearchPlan, type UserSearches } from './plan.ts';

export type AnyVacancyPlatform = VacancyPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>;
const hhPool = new AdaptiveTaskPool(1, 1);

async function normalizeIndividually(candidates: VacancyCandidate[],
  normalize:(candidate:VacancyCandidate)=>Promise<VacancyInput|null>): Promise<Map<string, VacancyInput | null | Error>> {
  const results = new Map<string, VacancyInput | null | Error>();
  for (const candidate of candidates) {
    try { results.set(candidate.sourceId, await normalize(candidate)); }
    catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
  }
  return results;
}

/** Every adapter reports the plan it actually ran: fetched searches, and the users those fetches served. */
function planned<T>(plan: SearchPlan<T>, result: { seen: number; discovered: number }): PlatformDiscoveryResult {
  const users = new Set(plan.searches.flatMap((search) => search.recipients.map((recipient) => recipient.userId)));
  return { searches: plan.searches.length, users: users.size, ...result };
}

const hhAdapter: VacancyPlatform<typeof hhPlatform.schema> = {
  ...hhPlatform,
  async discover(plan) {
    return planned(plan, await hhPool.run(() => scrapeHh(plan)));
  },
  normalize: normalizeHhCandidates,
};
const habrAdapter: VacancyPlatform<typeof habrPlatform.schema> = {
  ...habrPlatform,
  async discover(plan) { return planned(plan, await scrapeHabr(plan)); },
  normalize: candidates=>normalizeIndividually(candidates,normalizeAdditionalCandidate),
};
const rabotaAdapter: VacancyPlatform<typeof rabotaPlatform.schema> = {
  ...rabotaPlatform,
  async discover(plan) { return planned(plan, await scrapeRabota(plan)); },
  normalize: candidates=>normalizeIndividually(candidates,normalizeAdditionalCandidate),
};
const hireHiAdapter:VacancyPlatform<typeof hireHiPlatform.schema>={
  ...hireHiPlatform,
  async discover(plan){return planned(plan,await scrapeHireHi(plan));},
  normalize:candidates=>normalizeIndividually(candidates,normalizeHireHiCandidate),
};
function jsonLdBoardAdapter(id: JsonLdBoardId): VacancyPlatform<ReturnType<typeof boardPlatform>['schema']> {
  const platform = boardPlatform(id);
  return {
    ...platform,
    async discover(plan) { return planned(plan, await scrapeJsonLdBoard(id, plan)); },
    normalize: candidates => normalizeIndividually(candidates, normalizeJsonLdCandidate),
  };
}
const atsAdapter: VacancyPlatform<typeof atsPlatform.schema> = {
  ...atsPlatform,
  async discover(plan) { return planned(plan, await scrapeAts(plan)); },
  normalize: candidates => normalizeIndividually(candidates, normalizeAtsCandidate),
};
const trudvsemAdapter: VacancyPlatform<typeof trudvsemPlatform.schema> = {
  ...trudvsemPlatform,
  async discover(plan) { return planned(plan, await scrapeTrudvsem(plan)); },
  normalize: candidates => normalizeIndividually(candidates, normalizeTrudvsemCandidate),
};
const registeredPlatforms: AnyVacancyPlatform[] = [hhAdapter,habrAdapter,rabotaAdapter,hireHiAdapter,
  jsonLdBoardAdapter('geekjob'),jsonLdBoardAdapter('avito'),trudvsemAdapter,atsAdapter] as AnyVacancyPlatform[];

const platforms = new Map(registeredPlatforms.map((platform) => [platform.id, platform]));
export const searchPlatformIds = registeredPlatforms.map((platform) => platform.id);

export function getSearchPlatform(id: string): AnyVacancyPlatform {
  const platform = platforms.get(id);
  if (!platform) throw new Error(`Unknown search platform: ${id}`);
  return platform;
}

/** Validates one user's stored profile and returns the searches it asks this platform for. */
export function platformSearches(id: string, profile: unknown): unknown[] {
  const platform = getSearchPlatform(id);
  const parsed = v.safeParse(platform.schema, profile);
  if (!parsed.success) throw new Error(`${platform.name} search profile is invalid.`);
  return (parsed.output as { searches: unknown[] }).searches;
}

export async function discoverPlatformVacancies(id: string,
  demands: readonly UserSearches<unknown>[], now = Date.now()): Promise<PlatformDiscoveryResult> {
  const platform = getSearchPlatform(id);
  const plan = planPlatformSearches(id, demands,
    { enumerates: platform.enumerates, mergeText: platform.mergeText }, now);
  return platform.discover(plan as SearchPlan<never>);
}

export function normalizePlatformCandidates(source: string,
  candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>> {
  return getSearchPlatform(source).normalize(candidates);
}
