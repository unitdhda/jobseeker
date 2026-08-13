import * as v from 'valibot';
import { parseSourceKey, type VacancyCandidate, type VacancyInput } from '@jobseeker/engine/contracts';
import type { SourceContext, SourcesOptions } from './context.ts';
import { createSourceContext, snapshotSourcesOptions } from './context.ts';
import type {
  PlatformDiscoveryResult,
  PlatformSearch,
  SearchPlan,
  SearchPlatform,
  SourceSchema,
  VacancyPlatform,
} from './contract.ts';
import { createSourceUrlPolicy, type SourceUrlPolicy } from './http.ts';

export interface SourceProvider<S extends SourceSchema> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>, context: SourceContext): Promise<PlatformDiscoveryResult>;
  normalize(candidates: readonly VacancyCandidate[], context: SourceContext):
    Promise<Map<string, VacancyInput | null | Error>>;
  close?(context: SourceContext): Promise<void> | void;
}

export type AnySourceProvider = SourceProvider<SourceSchema>;
export type AnyVacancyPlatform = VacancyPlatform<SourceSchema>;

export interface CreateSourceProviderOptions<S extends SourceSchema> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>, context: SourceContext): Promise<PlatformDiscoveryResult>;
  normalize(candidates: readonly VacancyCandidate[], context: SourceContext):
    Promise<Map<string, VacancyInput | null | Error>>;
  close?(context: SourceContext): Promise<void> | void;
}

function snapshotHosts(hosts: readonly string[]): readonly string[] {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new TypeError('Invalid source provider: expected at least one declared host.');
  }
  return Object.freeze([...new Set(hosts)]);
}

/** Builds an inert definition; collection retrieval is the only operation that binds runtime ports. */
export function createSourceProvider<S extends SourceSchema>(
  input: CreateSourceProviderOptions<S>,
): SourceProvider<S> {
  const id = parseSourceKey(input.id);
  if (!input.name.trim() || typeof input.template !== 'function'
    || typeof input.discover !== 'function' || typeof input.normalize !== 'function') {
    throw new TypeError(`Invalid source provider ${id}.`);
  }
  const hosts = snapshotHosts(input.hosts);
  // Validate declarations at factory time without retaining this temporary policy.
  createSourceUrlPolicy([{ id, hosts }]);
  const provider: SourceProvider<S> = {
    id,
    name: input.name,
    schema: input.schema,
    template: input.template,
    hosts,
    ...(input.enumerates === undefined ? {} : { enumerates: input.enumerates }),
    ...(input.mergeText === undefined ? {} : { mergeText: input.mergeText }),
    discover: input.discover,
    async normalize(candidates, context) {
      const mismatch = candidates.find((candidate) => candidate.source !== id);
      if (mismatch) {
        throw new Error(`Source provider ${id} cannot normalize candidate source ${mismatch.source}.`);
      }
      return input.normalize(candidates, context);
    },
    ...(input.close ? { close: input.close } : {}),
  };
  return Object.freeze(provider);
}

export interface Sources {
  readonly urlPolicy: SourceUrlPolicy;
  readonly platformIds: readonly string[];
  getProviders(): readonly AnySourceProvider[];
  getProvider(id: string): AnySourceProvider | undefined;
  getPlatform(id: string): AnyVacancyPlatform;
  platformSearches(id: string, profile: unknown): readonly unknown[];
  discover(id: string, plan: SearchPlan<unknown>): Promise<PlatformDiscoveryResult>;
  normalize(source: string, candidates: readonly VacancyCandidate[]):
    Promise<Map<string, VacancyInput | null | Error>>;
  close(): Promise<void>;
}

export interface MutableSources extends Sources {
  setProvider(provider: AnySourceProvider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}

function unknownProvider(id: string): Error {
  return new Error(`Unknown search platform: ${id}.`);
}

export function createSources(inputOptions: SourcesOptions): MutableSources {
  const options = snapshotSourcesOptions(inputOptions);
  const providers = new Map<string, AnySourceProvider>();
  const owned: AnySourceProvider[] = [];
  const ownedSet = new Set<AnySourceProvider>();
  const policy = createSourceUrlPolicy();
  const context = createSourceContext(options, policy);
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const assertMutable = (): void => {
    if (closed) throw new Error('Sources collection is closed.');
  };

  const bind = (provider: AnySourceProvider): AnyVacancyPlatform => Object.freeze({
    id: provider.id,
    name: provider.name,
    schema: provider.schema,
    template: provider.template,
    hosts: provider.hosts,
    ...(provider.enumerates === undefined ? {} : { enumerates: provider.enumerates }),
    ...(provider.mergeText === undefined ? {} : { mergeText: provider.mergeText }),
    discover: (plan: SearchPlan<never>) => provider.discover(plan, context),
    normalize: (candidates: readonly VacancyCandidate[]) => provider.normalize(candidates, context),
  });

  const collection: MutableSources = {
    urlPolicy: policy,
    get platformIds(): readonly string[] {
      return Object.freeze([...providers.keys()]);
    },
    getProviders(): readonly AnySourceProvider[] {
      return Object.freeze([...providers.values()]);
    },
    getProvider(id: string): AnySourceProvider | undefined {
      return providers.get(id);
    },
    getPlatform(id: string): AnyVacancyPlatform {
      const provider = providers.get(id);
      if (!provider) throw unknownProvider(id);
      return bind(provider);
    },
    platformSearches(id: string, profile: unknown): readonly unknown[] {
      const provider = providers.get(id);
      if (!provider) throw unknownProvider(id);
      const result = v.safeParse(provider.schema, profile);
      if (!result.success) throw new TypeError(`Invalid ${id} search profile: ${result.issues[0]?.message ?? 'schema mismatch'}.`);
      const output = result.output as { readonly searches?: unknown };
      if (!Array.isArray(output.searches)) throw new TypeError(`Invalid ${id} search profile: expected searches array.`);
      return Object.freeze([...output.searches]);
    },
    async discover(id: string, plan: SearchPlan<unknown>): Promise<PlatformDiscoveryResult> {
      const provider = providers.get(id);
      if (!provider) throw unknownProvider(id);
      // Provider schemas are existential inside a heterogeneous collection; profile validation happened before demand compilation.
      return provider.discover(plan as SearchPlan<never>, context);
    },
    async normalize(source: string, candidates: readonly VacancyCandidate[]) {
      const provider = providers.get(source);
      if (!provider) throw unknownProvider(source);
      return provider.normalize(candidates, context);
    },
    setProvider(provider: AnySourceProvider): void {
      assertMutable();
      parseSourceKey(provider.id);
      // Validate and snapshot trusted metadata through the factory contract before ownership changes.
      createSourceUrlPolicy([provider]);
      if (!ownedSet.has(provider)) {
        ownedSet.add(provider);
        owned.push(provider);
        policy.addProvider(provider);
      }
      providers.set(provider.id, provider);
    },
    deleteProvider(id: string): void {
      assertMutable();
      providers.delete(id);
    },
    clearProviders(): void {
      assertMutable();
      providers.clear();
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const failures: unknown[] = [];
        for (const provider of owned) {
          try {
            await provider.close?.(context);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Multiple source providers failed to close.');
      })();
      return closePromise;
    },
  };
  return collection;
}
