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
}

export type PlatformProfile<P extends SearchPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>> =
  InferOutput<P['schema']>;

export interface PlatformDiscoveryResult { searches: number; seen: number; discovered: number }
export interface VacancyPlatform<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends SearchPlatform<S> {
  discover(userId: string, profile: InferOutput<S>): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
}

import * as v from 'valibot';
import { AdaptiveTaskPool } from '../concurrency.ts';
import { normalizeAdditionalCandidate, scrapeHabr, scrapeRabota } from './additional.ts';
import { normalizeHhCandidates, scrapeHh } from './hh.ts';
import { hhPlatform } from './hh.ts';
import { habrPlatform, rabotaPlatform } from './additional.ts';

export type AnyVacancyPlatform = VacancyPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>;
const hhPool = new AdaptiveTaskPool(1, 1);

async function normalizeIndividually(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>> {
  const results = new Map<string, VacancyInput | null | Error>();
  for (const candidate of candidates) {
    try { results.set(candidate.sourceId, await normalizeAdditionalCandidate(candidate)); }
    catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
  }
  return results;
}

const hhAdapter: VacancyPlatform<typeof hhPlatform.schema> = {
  ...hhPlatform,
  async discover(userId, profile) {
    const result = await hhPool.run(() => scrapeHh(userId, profile));
    return { searches: profile.searches.length, ...result };
  },
  normalize: normalizeHhCandidates,
};
const habrAdapter: VacancyPlatform<typeof habrPlatform.schema> = {
  ...habrPlatform,
  async discover(userId, profile) {
    const result = await scrapeHabr(userId, profile);
    return { searches: profile.searches.length, ...result };
  },
  normalize: normalizeIndividually,
};
const rabotaAdapter: VacancyPlatform<typeof rabotaPlatform.schema> = {
  ...rabotaPlatform,
  async discover(userId, profile) {
    const result = await scrapeRabota(userId, profile);
    return { searches: profile.searches.length, ...result };
  },
  normalize: normalizeIndividually,
};
const registeredPlatforms: AnyVacancyPlatform[] = [hhAdapter,habrAdapter,rabotaAdapter] as AnyVacancyPlatform[];

const platforms = new Map(registeredPlatforms.map((platform) => [platform.id, platform]));
export const searchPlatformIds = registeredPlatforms.map((platform) => platform.id);

export function getSearchPlatform(id: string): AnyVacancyPlatform {
  const platform = platforms.get(id);
  if (!platform) throw new Error(`Unknown search platform: ${id}`);
  return platform;
}

export async function discoverPlatformVacancies(id: string, userId: string, profile: unknown): Promise<PlatformDiscoveryResult> {
  const platform = getSearchPlatform(id);
  const parsed = v.safeParse(platform.schema, profile);
  if (!parsed.success) throw new Error(`${platform.name} search profile is invalid.`);
  return platform.discover(userId, parsed.output);
}

export function normalizePlatformCandidates(source: string,
  candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>> {
  return getSearchPlatform(source).normalize(candidates);
}
