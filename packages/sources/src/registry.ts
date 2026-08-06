import * as v from 'valibot';
import type { BaseIssue, BaseSchema } from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { PlatformDiscoveryResult, SearchPlan, VacancyPlatform } from './contract.ts';

import { AdaptiveTaskPool } from '@jobseeker/engine/concurrency';
import {
  createSourcesRuntime, currentSourcesRuntime, runWithSources, type SourcesOptions, type SourcesRuntime,
} from './config.ts';
import { registerSourceHosts } from './http.ts';
import { normalizeAdditionalCandidate, scrapeHabr, scrapeRabota } from './additional.ts';
import { normalizeHhCandidates, scrapeHh } from './hh.ts';
import { hhPlatform } from './hh.ts';
import { habrPlatform, rabotaPlatform } from './additional.ts';
import { hireHiPlatform, normalizeHireHiCandidate, scrapeHireHi } from './hirehi.ts';
import { atsPlatform, normalizeAtsCandidate, scrapeAts } from './ats.ts';
import { boardPlatform, normalizeJsonLdCandidate, scrapeJsonLdBoard, type JsonLdBoardId } from './boards.ts';
import { normalizeTrudvsemCandidate, scrapeTrudvsem, trudvsemPlatform } from './trudvsem.ts';

export type AnyVacancyPlatform = VacancyPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>;
const hhPools = new WeakMap<SourcesRuntime, AdaptiveTaskPool>();
function hhPool(): AdaptiveTaskPool {
  const owner=currentSourcesRuntime(),existing=hhPools.get(owner);
  if(existing)return existing;
  const created=new AdaptiveTaskPool(1,1);hhPools.set(owner,created);return created;
}

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
    return planned(plan, await hhPool().run(() => scrapeHh(plan)));
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
for (const platform of registeredPlatforms) registerSourceHosts(platform.id, platform.hosts);
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

export function normalizePlatformCandidates(source: string,
  candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>> {
  return getSearchPlatform(source).normalize(candidates);
}

export interface SourceRegistry {
  readonly platformIds: readonly string[];
  getPlatform(id: string): AnyVacancyPlatform;
  platformSearches(id: string, profile: unknown): unknown[];
  normalize(source: string, candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
  close(): Promise<void>;
}

/** Creates one isolated adapter registry, including its browser context, pools, settings, and injected listing sink. */
export function createSourceRegistry(options: SourcesOptions): SourceRegistry {
  const owner=createSourcesRuntime(options);
  const bound=new Map<string,AnyVacancyPlatform>();
  for(const platform of registeredPlatforms){
    const wrapped={...platform,
      template:()=>runWithSources(owner,()=>platform.template()),
      discover:(plan:SearchPlan<never>)=>runWithSources(owner,()=>platform.discover(plan)),
      normalize:(candidates:VacancyCandidate[])=>runWithSources(owner,()=>platform.normalize(candidates)),
    } as AnyVacancyPlatform;
    bound.set(platform.id,wrapped);
  }
  const get=(id:string):AnyVacancyPlatform=>{
    const platform=bound.get(id);if(!platform)throw new Error(`Unknown search platform: ${id}`);return platform;
  };
  return {
    platformIds:[...searchPlatformIds],
    getPlatform:get,
    platformSearches(id,profile){
      const platform=get(id),parsed=v.safeParse(platform.schema,profile);
      if(!parsed.success)throw new Error(`${platform.name} search profile is invalid.`);
      return (parsed.output as {searches:unknown[]}).searches;
    },
    normalize:(source,candidates)=>get(source).normalize(candidates),
    close:()=>runWithSources(owner,async()=>{
      const {closeHhBrowser}=await import('./hh.ts');
      await closeHhBrowser();hhPools.delete(owner);
    }),
  };
}
