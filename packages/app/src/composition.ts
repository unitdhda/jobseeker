import type { PoolConfig } from 'pg';
import type { Models } from '@earendil-works/pi-ai';
import { createSourceUrlPolicy, createSources, type MutableSources } from '@jobseeker/sources';
import { createStore, type Store } from '@jobseeker/store';
import { composeAiModels } from './ai.ts';
import { createCredentialStore } from './ai-auth.ts';
import { config as defaultConfig, type AppConfig } from './config.ts';
import { loadExtensionsFrom, type ExtensionState, type LoadedExtensions } from './extensions.ts';
import { createRuntimeState } from './runtime-state.ts';

export interface ApplicationComposition {
  readonly config: AppConfig;
  readonly extensions: LoadedExtensions;
  readonly state: ExtensionState;
  readonly store: Store;
  readonly sources: MutableSources;
  readonly ai: Models;
  readonly enabledSourceProviderIds: readonly string[];
  close(): Promise<void>;
}
export interface CompositionDependencies {
  readonly loadExtensions?: typeof loadExtensionsFrom;
  readonly createStore?: typeof createStore;
  readonly createSources?: typeof createSources;
  readonly composeAi?: typeof composeAiModels;
  readonly createState?: typeof createRuntimeState;
  readonly log?: (message: string) => void;
  readonly errorMessage?: (error: unknown) => string;
}

function ssl(config: AppConfig): PoolConfig['ssl'] {
  if (config.postgresSsl === 'disable') return false;
  if (config.postgresSsl === 'verify-full' && !config.postgresCaCert) {
    throw new TypeError('POSTGRES_CA_CERT is required when POSTGRES_SSL=verify-full.');
  }
  return {
    rejectUnauthorized: config.postgresSsl === 'verify-full',
    ...(config.postgresCaCert ? { ca: config.postgresCaCert } : {}),
  };
}

export async function composeApplication(config: AppConfig = defaultConfig,
  dependencies: CompositionDependencies = {}): Promise<ApplicationComposition> {
  const stateFactory = dependencies.createState ?? createRuntimeState;
  const state = stateFactory({ url: config.stateStorageUrl, key: config.stateStorageKey,
    bucket: config.stateStorageBucket, encryptionKey: config.runtimeStateEncryptionKey });
  const load = dependencies.loadExtensions ?? loadExtensionsFrom;
  // Extension loading is the first resource-owning operation; state construction above is inert until a hook uses it.
  const extensions = await load(config.extensionsPath, { env: process.env, state, log: dependencies.log });
  const providerIds = extensions.sourceProviders.map((provider) => provider.id);
  if (new Set(providerIds).size !== providerIds.length) throw new Error('Loaded source provider IDs are not unique.');
  const available = new Set(providerIds);
  const enabled = config.searchPlatforms ?? providerIds;
  const missing = enabled.filter((id) => !available.has(id));
  if (missing.length) throw new Error(`Requested search platforms are not registered: ${missing.join(', ')}.`);

  // The store must retain guards for disabled providers because persisted vacancies outlive discovery configuration.
  const trustedUrls = createSourceUrlPolicy(extensions.sourceProviders);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for application composition.');
  const storeFactory = dependencies.createStore ?? createStore;
  const store = storeFactory({ databaseUrl: config.databaseUrl, poolMax: config.postgresPoolMax, ssl: ssl(config), settings: {
    telegramUserId: config.ownerTelegramUserId,
    accessRequestCooldownMinutes: config.accessRequestCooldownMinutes,
    prefilterMaxAgeDays: config.prefilterMaxAgeDays,
    searchPlatforms: Object.freeze([...enabled]), digestMinScore: config.digestMinScore, alertScore: config.alertScore,
    timezone: config.timezone, safeVacancyUrl: trustedUrls.safeVacancyUrl,
  } });
  let sources: MutableSources | undefined;
  try {
    const sourceFactory = dependencies.createSources ?? createSources;
    sources = sourceFactory({ limits: { searchNewVacancyLimit: config.searchNewVacancyLimit,
      searchPageBudgetPerPlatform: config.searchPageBudgetPerPlatform },
    trace: dependencies.log ? (event) => dependencies.log!(event) : () => undefined,
    errorMessage: dependencies.errorMessage ?? ((error) => error instanceof Error ? error.message : 'Source operation failed.'),
    recordListingCandidate: store.recordListingCandidate });
    for (const provider of extensions.sourceProviders) sources.setProvider(provider);

    const credentials = createCredentialStore({ state, filePath: config.aiAuthFile,
      withAdvisoryLock: (key, operation) => store.withAdvisoryLock(key, async () => operation()) });
    const aiFactory = dependencies.composeAi ?? composeAiModels;
    const ai = aiFactory(extensions.aiProviders, { credentials, env: process.env });
    let closed = false;
    return Object.freeze({ config, extensions, state, store, sources, ai,
      enabledSourceProviderIds: Object.freeze([...enabled]),
      async close(): Promise<void> {
        if (closed) return; closed = true;
        const results = await Promise.allSettled([sources!.close(), store.close()]);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Application composition close failed.');
      } });
  } catch (error) {
    await sources?.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    throw error;
  }
}
