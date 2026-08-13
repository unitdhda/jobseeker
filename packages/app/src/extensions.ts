import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Provider } from '@earendil-works/pi-ai';
import type { AnySourceProvider } from '@jobseeker/sources';
import * as sourcesToolkit from '@jobseeker/sources';
import * as apiDriver from '@jobseeker/sources/drivers/api';
import * as atsDriver from '@jobseeker/sources/drivers/ats';
import * as companySiteDriver from '@jobseeker/sources/drivers/company-site';
import * as jsonLdBoardDriver from '@jobseeker/sources/drivers/jsonld-board';
import { AdaptiveTaskPool, mapConcurrent } from '@jobseeker/engine/concurrency';

export interface ExtensionState {
  configured(): boolean;
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, plaintext: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface JobseekerExtensionApi {
  registerSourceProvider(provider: AnySourceProvider): void;
  registerAiProvider(provider: Provider): void;
  onStartup(hook: () => Promise<void> | void): void;
  onShutdown(hook: () => Promise<void> | void): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  log(message: string): void;
  readonly sources: typeof sourcesToolkit & {
    readonly drivers: {
      readonly api: typeof apiDriver;
      readonly ats: typeof atsDriver;
      readonly companySite: typeof companySiteDriver;
      readonly jsonLdBoard: typeof jsonLdBoardDriver;
    };
  };
  readonly concurrency: { readonly AdaptiveTaskPool: typeof AdaptiveTaskPool; readonly mapConcurrent: typeof mapConcurrent };
  readonly state: ExtensionState;
}

export type JobseekerExtension = (api: JobseekerExtensionApi) => Promise<void> | void;
export interface LoadedExtensions {
  readonly names: readonly string[];
  readonly sourceProviders: readonly AnySourceProvider[];
  readonly aiProviders: readonly Provider[];
  readonly startupHooks: readonly (() => Promise<void> | void)[];
  readonly shutdownHooks: readonly (() => Promise<void> | void)[];
}

export interface ExtensionLoaderOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (message: string) => void;
  readonly state?: ExtensionState;
}

const moduleExtensions = ['.ts', '.mts', '.mjs', '.js'] as const;
const unavailableState: ExtensionState = Object.freeze({
  configured: () => false,
  get: async () => null,
  put: async () => { throw new Error('Encrypted extension state is not configured.'); },
  delete: async () => { throw new Error('Encrypted extension state is not configured.'); },
});

interface ExtensionEntry { readonly name: string; readonly path: string }
async function extensionEntries(root: string): Promise<readonly ExtensionEntry[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: ExtensionEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = resolve(root, entry.name);
    if (entry.isFile()) {
      if (moduleExtensions.some((suffix) => entry.name.endsWith(suffix)) && !entry.name.endsWith('.d.ts')) {
        found.push({ name: entry.name, path });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const suffix of moduleExtensions) {
      const candidate = resolve(path, `index${suffix}`);
      if (await stat(candidate).then((value) => value.isFile()).catch(() => false)) {
        found.push({ name: entry.name, path: candidate });
        break;
      }
    }
  }
  return Object.freeze(found);
}

function frozenEnvironment(input: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(Object.entries(input)));
}

export async function loadExtensionsFrom(
  root: string,
  options: ExtensionLoaderOptions = {},
): Promise<LoadedExtensions> {
  const names: string[] = [];
  const sourceProviders: AnySourceProvider[] = [];
  const aiProviders: Provider[] = [];
  const startupHooks: Array<() => Promise<void> | void> = [];
  const shutdownHooks: Array<() => Promise<void> | void> = [];
  const sourceIds = new Set<string>();
  const aiIds = new Set<string>();
  const env = frozenEnvironment(options.env ?? process.env);
  const logger = options.log ?? ((message: string) => console.info(message));
  const state = options.state ?? unavailableState;

  for (const entry of await extensionEntries(root)) {
    const imported = await import(`${pathToFileURL(entry.path).href}?jobseeker=${encodeURIComponent(entry.name)}`) as {
      readonly default?: JobseekerExtension;
    };
    if (typeof imported.default !== 'function') {
      throw new Error(`Extension ${entry.name} must default-export a register(api) function.`);
    }
    let registering = true;
    const active = (): void => {
      if (!registering) throw new Error(`Extension ${entry.name} attempted registration after its register function completed.`);
    };
    const api: JobseekerExtensionApi = Object.freeze({
      registerSourceProvider(provider: AnySourceProvider): void {
        active();
        if (sourceIds.has(provider.id)) throw new Error(`Duplicate source provider ID: ${provider.id}.`);
        sourceIds.add(provider.id); sourceProviders.push(provider);
      },
      registerAiProvider(provider: Provider): void {
        active();
        if (!provider.id?.trim()) throw new TypeError(`Extension ${entry.name} registered an invalid AI provider.`);
        if (aiIds.has(provider.id)) throw new Error(`Duplicate AI provider ID: ${provider.id}.`);
        aiIds.add(provider.id); aiProviders.push(provider);
      },
      onStartup(hook: () => Promise<void> | void): void {
        active(); if (typeof hook !== 'function') throw new TypeError('Invalid extension startup hook.'); startupHooks.push(hook);
      },
      onShutdown(hook: () => Promise<void> | void): void {
        active(); if (typeof hook !== 'function') throw new TypeError('Invalid extension shutdown hook.'); shutdownHooks.push(hook);
      },
      env,
      log(message: string): void { logger(`[extension ${entry.name}] ${message}`); },
      sources: Object.freeze({ ...sourcesToolkit,
        drivers: Object.freeze({ api: apiDriver, ats: atsDriver, companySite: companySiteDriver, jsonLdBoard: jsonLdBoardDriver }) }),
      concurrency: Object.freeze({ AdaptiveTaskPool, mapConcurrent }),
      state,
    });
    try { await imported.default(api); } finally { registering = false; }
    names.push(entry.name);
  }
  return Object.freeze({
    names: Object.freeze(names), sourceProviders: Object.freeze(sourceProviders), aiProviders: Object.freeze(aiProviders),
    startupHooks: Object.freeze(startupHooks), shutdownHooks: Object.freeze(shutdownHooks),
  });
}

let loading: Promise<LoadedExtensions> | undefined;
export function loadExtensions(): Promise<LoadedExtensions> {
  loading ??= loadExtensionsFrom(resolve(process.env.JOBSEEKER_EXTENSIONS ?? './extensions'));
  return loading;
}
