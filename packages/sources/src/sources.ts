import * as v from 'valibot';
import type { BaseIssue, BaseSchema } from 'valibot';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { SourceContext, SourcesOptions } from './context.ts';
import { createSourceContext } from './context.ts';
import type {
  PlatformDiscoveryResult, PlatformSearch, SearchPlan, SearchPlatform, VacancyPlatform,
} from './contract.ts';
import { createSourceUrlPolicy, type SourceUrlPolicy } from './http.ts';

export interface SourceProvider<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>, context: SourceContext): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[], context: SourceContext):
    Promise<Map<string, VacancyInput | null | Error>>;
  /** Release provider-owned browser, pool, or other runtime state. */
  close?(context: SourceContext): Promise<void> | void;
}

export type AnySourceProvider = SourceProvider<BaseSchema<unknown, unknown, BaseIssue<unknown>>>;
export type AnyVacancyPlatform = VacancyPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>;

export interface CreateSourceProviderOptions<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>
  extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>, context: SourceContext): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[], context: SourceContext):
    Promise<Map<string, VacancyInput | null | Error>>;
  close?(context: SourceContext): Promise<void> | void;
}

/** Builds one inert provider definition. A Sources collection supplies runtime ports when it invokes the provider. */
export function createSourceProvider<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  input: CreateSourceProviderOptions<S>,
): SourceProvider<S> {
  return {
    ...input,
    hosts: Object.freeze([...new Set(input.hosts)]),
    async normalize(candidates, context) {
      const mismatch = candidates.find((candidate) => candidate.source !== input.id);
      if (mismatch) throw new Error(`Source provider ${input.id} cannot normalize candidate source ${mismatch.source}.`);
      return input.normalize(candidates, context);
    },
  } as SourceProvider<S>;
}

export interface Sources {
  /** Immutable URL policy derived from every provider this collection has owned. */
  readonly urlPolicy: SourceUrlPolicy;
  /** Snapshot of provider ids in registration order. */
  readonly platformIds: readonly string[];
  getProviders(): readonly AnySourceProvider[];
  getProvider(id: string): AnySourceProvider | undefined;
  /** Runtime-bound platform used by the engine and profile workflows. */
  getPlatform(id: string): AnyVacancyPlatform;
  platformSearches(id: string, profile: unknown): unknown[];
  normalize(source: string, candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
  /** Idempotently closes every provider ever owned by this collection, including replaced providers. */
  close(): Promise<void>;
}

export interface MutableSources extends Sources {
  /** Upsert or replace by provider id. Provider ids are unique within this collection. */
  setProvider(provider: AnySourceProvider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}

function unknownProvider(id: string): Error {
  return new Error(`Unknown search platform: ${id}`);
}

const defaultOptions: SourcesOptions = {
  limits: { searchNewVacancyLimit: 1, searchPageBudgetPerPlatform: 1 },
  trace: () => undefined,
  errorMessage: String,
  recordListingCandidate: async () => {
    throw new Error('Source discovery requires createSources runtime options.');
  },
};

function bindProvider(provider: AnySourceProvider, context: () => SourceContext): AnyVacancyPlatform {
  return {
    ...provider,
    discover: (plan: SearchPlan<never>) => provider.discover(plan, context()),
    normalize: (candidates: VacancyCandidate[]) => provider.normalize(candidates, context()),
  } as AnyVacancyPlatform;
}

/** Creates an empty collection; provider implementations receive explicit context instead of ambient state. */
export function createSources(options: SourcesOptions = defaultOptions): MutableSources {
  const providers = new Map<string, AnySourceProvider>();
  const platforms = new Map<string, AnyVacancyPlatform>();
  const ownedProviders = new Set<AnySourceProvider>();
  let urlPolicy = createSourceUrlPolicy();
  let closePromise: Promise<void> | undefined;
  const context = (): SourceContext => createSourceContext(options, urlPolicy);

  const requirePlatform = (id: string): AnyVacancyPlatform => {
    const platform = platforms.get(id);
    if (!platform) throw unknownProvider(id);
    return platform;
  };

  const collection: MutableSources = {
    get urlPolicy() { return urlPolicy; },
    get platformIds() { return [...providers.keys()]; },
    getProviders: () => [...providers.values()],
    getProvider: (id) => providers.get(id),
    getPlatform: requirePlatform,
    setProvider(provider) {
      if (closePromise) throw new Error('Cannot register a source provider after the collection has closed.');
      providers.set(provider.id, provider);
      platforms.set(provider.id, bindProvider(provider, context));
      ownedProviders.add(provider);
      urlPolicy = createSourceUrlPolicy(ownedProviders);
    },
    deleteProvider(id) {
      if (closePromise) throw new Error('Cannot delete a source provider after the collection has closed.');
      providers.delete(id);
      platforms.delete(id);
    },
    clearProviders() {
      if (closePromise) throw new Error('Cannot clear source providers after the collection has closed.');
      providers.clear();
      platforms.clear();
    },
    platformSearches(id, profile) {
      const platform = requirePlatform(id);
      const parsed = v.safeParse(platform.schema, profile);
      if (!parsed.success) throw new Error(`${platform.name} search profile is invalid.`);
      const searches = (parsed.output as { searches?: unknown }).searches;
      if (!Array.isArray(searches)) throw new Error(`${platform.name} search profile is invalid.`);
      return searches;
    },
    normalize: (source, candidates) => requirePlatform(source).normalize(candidates),
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          const errors: unknown[] = [];
          for (const provider of ownedProviders) {
            try { await provider.close?.(context()); }
            catch (error) { errors.push(error); }
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, 'Failed to close source providers.');
        })();
      }
      return closePromise;
    },
  };
  return collection;
}
