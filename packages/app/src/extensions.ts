/**
 * Deployment extensions: the application ships no vacancy sources and no extra AI providers of its own — not even
 * inertly, so the bundle carries generic drivers rather than a catalogue of employers. A deployment drops ESM
 * modules into JOBSEEKER_EXTENSIONS (default ./extensions), each default-exporting a register function;
 * everything an extension may plug into arrives through the api argument, so extension files depend only on their
 * own packages (a browser driver, a vendor SDK) and run against the built application, where workspace internals
 * are bundled and not importable. The reference providers in packages/sources/examples are copied into a
 * deployment's extensions directory, never imported from here.
 */
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
import {
  deleteEncryptedRuntimeState, getEncryptedRuntimeState, putEncryptedRuntimeState, runtimeStateConfigured,
} from './runtime-state.ts';

export interface JobseekerExtensionApi {
  /** Registers a vacancy-source provider; SEARCH_PLATFORMS decides whether it also discovers. */
  registerSourceProvider(provider: AnySourceProvider): void;
  /** Registers a pi-ai provider; it serves traffic only when an AI_*_MODEL identifier selects it. */
  registerAiProvider(provider: Provider): void;
  /** Runs after composition, before the engine loop starts. */
  onStartup(hook: () => Promise<void> | void): void;
  /** Runs during graceful shutdown, after the engine loop stopped. */
  onShutdown(hook: () => Promise<void> | void): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  log(message: string): void;
  /** The @jobseeker/sources public surface and its generic drivers. */
  readonly sources: typeof sourcesToolkit & {
    drivers: {
      api: typeof apiDriver;
      ats: typeof atsDriver;
      companySite: typeof companySiteDriver;
      jsonLdBoard: typeof jsonLdBoardDriver;
    };
  };
  readonly concurrency: { AdaptiveTaskPool: typeof AdaptiveTaskPool; mapConcurrent: typeof mapConcurrent };
  /** Optional encrypted blob store for state that must survive the host (browser profiles, credentials). */
  readonly state: {
    configured(): boolean;
    get(path: string): Promise<Uint8Array | null>;
    put(path: string, plaintext: Uint8Array): Promise<void>;
    delete(path: string): Promise<void>;
  };
}

export type JobseekerExtension = (api: JobseekerExtensionApi) => Promise<void> | void;

export interface LoadedExtensions {
  names: string[];
  sourceProviders: AnySourceProvider[];
  aiProviders: Provider[];
  startupHooks: Array<() => Promise<void> | void>;
  shutdownHooks: Array<() => Promise<void> | void>;
}

const moduleExtensions = ['.ts', '.mts', '.mjs', '.js'];

async function extensionEntries(root: string): Promise<Array<{ name: string; path: string }>> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const found: Array<{ name: string; path: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = resolve(root, entry.name);
    if (entry.isFile()) {
      if (moduleExtensions.some((suffix) => entry.name.endsWith(suffix)) && !entry.name.endsWith('.d.ts')) {
        found.push({ name: entry.name, path });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const index of moduleExtensions.map((suffix) => `index${suffix}`)) {
      const candidate = resolve(path, index);
      const exists = await stat(candidate).then((info) => info.isFile()).catch(() => false);
      if (exists) { found.push({ name: entry.name, path: candidate }); break; }
    }
  }
  return found;
}

function apiFor(name: string, loaded: LoadedExtensions): JobseekerExtensionApi {
  return {
    registerSourceProvider: (provider) => { loaded.sourceProviders.push(provider); },
    registerAiProvider: (provider) => { loaded.aiProviders.push(provider); },
    onStartup: (hook) => { loaded.startupHooks.push(hook); },
    onShutdown: (hook) => { loaded.shutdownHooks.push(hook); },
    env: process.env,
    log: (message) => console.info(`[extension ${name}] ${message}`),
    sources: Object.freeze({
      ...sourcesToolkit,
      drivers: { api: apiDriver, ats: atsDriver, companySite: companySiteDriver, jsonLdBoard: jsonLdBoardDriver },
    }),
    concurrency: { AdaptiveTaskPool, mapConcurrent },
    state: {
      configured: runtimeStateConfigured,
      get: getEncryptedRuntimeState,
      put: putEncryptedRuntimeState,
      delete: deleteEncryptedRuntimeState,
    },
  };
}

/** Loads every extension under one directory; exported separately from the memoized entry for tests. */
export async function loadExtensionsFrom(root: string): Promise<LoadedExtensions> {
  const loaded: LoadedExtensions = { names: [], sourceProviders: [], aiProviders: [],
    startupHooks: [], shutdownHooks: [] };
  for (const entry of await extensionEntries(root)) {
    const imported = await import(pathToFileURL(entry.path).href) as { default?: JobseekerExtension };
    if (typeof imported.default !== 'function') {
      throw new Error(`Extension ${entry.name} must default-export a register(api) function.`);
    }
    await imported.default(apiFor(entry.name, loaded));
    loaded.names.push(entry.name);
  }
  return loaded;
}

let loading: Promise<LoadedExtensions> | undefined;

/** Loads every extension exactly once per process; entrypoints await this before composing providers. */
export function loadExtensions(): Promise<LoadedExtensions> {
  loading ??= (async () => {
    const loaded = await loadExtensionsFrom(resolve(process.env.JOBSEEKER_EXTENSIONS ?? './extensions'));
    if (loaded.names.length) {
      console.info(`Extensions loaded: ${loaded.names.join(', ')} — `
        + `${loaded.sourceProviders.length} source provider(s), ${loaded.aiProviders.length} AI provider(s).`);
    }
    return loaded;
  })();
  return loading;
}
