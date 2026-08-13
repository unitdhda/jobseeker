import { basename } from 'node:path';
import * as v from 'valibot';
import { compileDemand, type CompiledDemand, type CompiledUnit, type NamedSearch } from '@jobseeker/engine/subscribe';
import { parseCvContentHash, parseSourceKey, type CvContentHash, type SourceKey, type UserId } from '@jobseeker/engine/contracts';
import type { CareerProfile } from '@jobseeker/engine/prefilter';
import type { PlatformValidationTemplate, SourceSchema } from '@jobseeker/sources';
import type { ThinkingLevel, Usage } from '@earendil-works/pi-ai';
import { generateJson, type JsonModels } from './ai.ts';
import type { ModelId } from './config.ts';
import {
  careerProfilePrompt,
  careerProfileSchema,
  careerProfileSystemPrompt,
  normalizeCareerProfileJson,
  parseStoredSearchProfile,
  searchProfilePrompt,
  searchProfileSystemPrompt,
  storedCareerProfile,
  storedSearchProfile,
  type StoredSearchProfile,
} from './career-profile.ts';

export interface ProfileProvider {
  readonly id: string;
  readonly schema: SourceSchema;
  template(): PlatformValidationTemplate;
}
export interface ProfileCvSource { readonly hash: CvContentHash; readonly text: string }
export interface ProfileRefreshPorts {
  getCvSource(userId: UserId): Promise<ProfileCvSource | null>;
  getCvHash(userId: UserId): Promise<CvContentHash | null>;
  saveCareerProfile(userId: UserId, value: unknown): Promise<void>;
  getSearchProfile(userId: UserId, platform: SourceKey): Promise<unknown>;
  saveSearchProfile(userId: UserId, platform: SourceKey, value: unknown): Promise<void>;
  activeUnitQueries(platform: SourceKey): Promise<readonly unknown[]>;
  existingCompiledUnits(): Promise<readonly CompiledUnit<NamedSearch>[]>;
  applyDemand(userId: UserId, demand: CompiledDemand<NamedSearch>, initialCadence: number): Promise<void>;
  reserveProfileUsage(userId: UserId, agent: string): Promise<void>;
  recordLlmUsage(userId: UserId, agent: string, model: string, usage: Usage): Promise<void>;
  refreshRoleEquivalences(): Promise<void>;
  backfillRecentStock(userId: UserId): Promise<void>;
}
export interface ProfileRefreshOptions {
  readonly userId: UserId;
  readonly providers: readonly ProfileProvider[];
  readonly models: JsonModels;
  readonly model?: ModelId;
  readonly thinking?: ThinkingLevel;
  readonly clusterSimilarity: number;
  readonly initialCadenceMinutes: number;
  readonly ports: ProfileRefreshPorts;
  readonly errorMessage?: (error: unknown) => string;
}
export interface ProfileRefreshResult {
  readonly cvHash: CvContentHash;
  readonly career: CareerProfile;
  readonly generatedPlatforms: readonly SourceKey[];
  readonly failedPlatforms: Readonly<Record<string, string>>;
  readonly demand: CompiledDemand<NamedSearch>;
}

export class StaleCvError extends Error {
  constructor() { super('Authoritative CV changed during profile generation.'); this.name = 'StaleCvError'; }
}
async function assertCvHash(options: ProfileRefreshOptions, expected: CvContentHash): Promise<void> {
  if (await options.ports.getCvHash(options.userId) !== expected) throw new StaleCvError();
}
function wording(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['query', 'text', 'name']) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  return null;
}
function namedSearches(profile: unknown): readonly NamedSearch[] {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return Object.freeze([]);
  const searches = (profile as { searches?: unknown }).searches;
  if (!Array.isArray(searches)) throw new TypeError('Generated source profile has no searches array.');
  return Object.freeze(searches.map((search) => {
    if (typeof search !== 'object' || search === null || Array.isArray(search)
      || typeof (search as { name?: unknown }).name !== 'string' || !(search as { name: string }).name.trim()) {
      throw new TypeError('Generated source search has no name.');
    }
    return search as NamedSearch;
  }));
}

export async function refreshUserProfiles(options: ProfileRefreshOptions): Promise<ProfileRefreshResult> {
  if (!Number.isFinite(options.clusterSimilarity) || options.clusterSimilarity < 0 || options.clusterSimilarity > 1) {
    throw new RangeError('Invalid profile demand cluster similarity.');
  }
  if (!Number.isSafeInteger(options.initialCadenceMinutes) || options.initialCadenceMinutes < 1) {
    throw new RangeError('Invalid initial profile cadence.');
  }
  const source = await options.ports.getCvSource(options.userId);
  if (!source) throw new Error('Authoritative CV is not available.');
  const cvHash = parseCvContentHash(source.hash);
  await options.ports.reserveProfileUsage(options.userId, 'career-profile');
  const career = await generateJson({ models: options.models, model: options.model, role: 'Career profile', agent: 'career-profile',
    systemPrompt: careerProfileSystemPrompt, userPrompt: careerProfilePrompt(source.text), schema: careerProfileSchema,
    reasoning: options.thinking, repair: normalizeCareerProfileJson,
    recordUsage: (agent, model, usage) => options.ports.recordLlmUsage(options.userId, agent, model, usage) });
  await assertCvHash(options, cvHash);
  await options.ports.saveCareerProfile(options.userId, storedCareerProfile(cvHash, career));

  const generated = new Map<SourceKey, StoredSearchProfile>(); const failures: Record<string, string> = Object.create(null);
  const errorMessage = options.errorMessage ?? ((error) => error instanceof Error ? error.message : 'Profile generation failed.');
  for (const provider of options.providers) {
    const id = parseSourceKey(provider.id); const template = provider.template();
    try {
      await assertCvHash(options, cvHash);
      const existing = (await options.ports.activeUnitQueries(id)).map(wording).filter((item): item is string => item !== null);
      await options.ports.reserveProfileUsage(options.userId, `search-profile:${id}`);
      const profile = await generateJson({ models: options.models, model: options.model, role: `${id} search profile`,
        agent: `search-profile:${id}`, systemPrompt: searchProfileSystemPrompt(template),
        userPrompt: searchProfilePrompt(career, source.text, existing), schema: provider.schema, reasoning: options.thinking,
        recordUsage: (agent, model, usage) => options.ports.recordLlmUsage(options.userId, agent, model, usage) });
      await assertCvHash(options, cvHash);
      const stored = storedSearchProfile(cvHash, template.version, provider.schema, profile);
      await options.ports.saveSearchProfile(options.userId, id, stored); generated.set(id, stored);
    } catch (error) {
      if (error instanceof StaleCvError) throw error;
      failures[id] = errorMessage(error).slice(0, 500);
    }
  }
  await assertCvHash(options, cvHash);

  const demands: Array<{ userId: UserId; platform: SourceKey; searches: readonly NamedSearch[] }> = [];
  for (const provider of options.providers) {
    const id = parseSourceKey(provider.id); const template = provider.template();
    let stored = generated.get(id);
    if (!stored) {
      const persisted = await options.ports.getSearchProfile(options.userId, id);
      try { stored = parseStoredSearchProfile(persisted, cvHash, template.version, provider.schema); } catch { continue; }
    }
    demands.push({ userId: options.userId, platform: id, searches: namedSearches(stored.profile) });
  }
  const existing = await options.ports.existingCompiledUnits();
  const demand = compileDemand(demands, options.clusterSimilarity, existing);
  await options.ports.applyDemand(options.userId, demand, options.initialCadenceMinutes);
  await options.ports.refreshRoleEquivalences();
  await options.ports.backfillRecentStock(options.userId);
  return Object.freeze({ cvHash, career, generatedPlatforms: Object.freeze([...generated.keys()]),
    failedPlatforms: Object.freeze({ ...failures }), demand });
}

const executableName = basename(process.argv[1] ?? '');
if (executableName === 'profile-refresh.ts' || executableName === 'refresh-profiles.js') {
  void import('./profile-refresh-runner.ts')
    .then((runner) => runner.refreshMissingProfilesAndExit(refreshUserProfiles))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Profile refresh failed.'); process.exitCode = 1; });
}
