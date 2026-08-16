import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import type { Models } from '@earendil-works/pi-ai';
import type { EngineLoop, LoopPorts } from '@jobseeker/engine/loop';
import { createSourceProvider, createSources, type MutableSources } from '@jobseeker/sources';
import type { Store, StoreOptions } from '@jobseeker/store';
import { parseConfig } from '../src/config.ts';
import { composeApplication } from '../src/composition.ts';
import { startEngineOwnership } from '../src/engine-main.ts';
import type { LoadedExtensions } from '../src/extensions.ts';
import type { MatchingVocabularies } from '../src/matching-vocabularies.ts';

const schema = v.strictObject({ version: v.literal(1), searches: v.array(v.unknown()) });
const provider = (id: string, host: string) => createSourceProvider({ id, name: id, schema, hosts: [host],
  template: () => ({ platform: id, version: 1, purpose: id, jsonShape: {}, capabilities: {}, rules: [] }),
  discover: async () => ({ searches: 0, users: 0, seen: 0, discovered: 0 }), normalize: async () => new Map() });
const extensions = (providers = [provider('one', 'one.test'), provider('two', 'two.test')]): LoadedExtensions => ({
  names: ['test'], sourceProviders: providers, aiProviders: [], startupHooks: [], shutdownHooks: [],
});
const appConfig = (env: Record<string, string> = {}) => parseConfig({ DATABASE_URL: 'postgres://test', TELEGRAM_MODE: 'off', ...env });

function fakeStore(options: StoreOptions, events: string[]): Store {
  events.push('store');
  return { settings: options.settings, recordListingCandidate: async () => true,
    withAdvisoryLock: async <T>(_key: string, operation: () => Promise<T>) => operation(),
    close: async () => { events.push('store-close'); } } as unknown as Store;
}

test('unknown requested source fails before store/source/AI construction', async () => {
  const events: string[] = [];
  await assert.rejects(composeApplication(appConfig({ SEARCH_PLATFORMS: 'missing' }), {
    createState: () => ({ configured: () => false, get: async () => null, put: async () => undefined, delete: async () => undefined }),
    loadExtensions: async () => { events.push('extensions'); return extensions(); },
    createStore: (options) => fakeStore(options, events),
    createSources: (options) => { events.push('sources'); return {} as MutableSources; },
    composeAi: () => { events.push('ai'); return {} as Models; },
  }), /not registered/u);
  assert.deepEqual(events, ['extensions']);
});

test('composition guards all loaded hosts, registers every provider, and closes resources idempotently', async () => {
  const events: string[] = []; let capturedStoreOptions: StoreOptions | undefined; let capturedSources: MutableSources | undefined;
  const composition = await composeApplication(appConfig({ SEARCH_PLATFORMS: 'one' }), {
    createState: () => ({ configured: () => false, get: async () => null, put: async () => undefined, delete: async () => undefined }),
    loadExtensions: async () => { events.push('extensions'); return extensions(); },
    createStore: (options) => { capturedStoreOptions = options; return fakeStore(options, events); },
    createSources: (options) => { events.push('sources'); capturedSources = createSources(options); return capturedSources; },
    composeAi: () => { events.push('ai'); return {} as Models; },
  });
  assert.deepEqual(events.slice(0, 4), ['extensions', 'store', 'sources', 'ai']);
  assert.deepEqual(composition.enabledSourceProviderIds, ['one']);
  assert.deepEqual(capturedSources!.platformIds, ['one', 'two']);
  assert.equal(capturedStoreOptions!.settings.safeVacancyUrl('two', 'https://two.test/job'), 'https://two.test/job');
  assert.throws(() => capturedStoreOptions!.settings.safeVacancyUrl('two', 'https://evil.test/job'), /Unsafe/u);
  await composition.close(); await composition.close();
  assert.deepEqual(events.slice(-1), ['store-close']);
});

const emptyPorts = {} as LoopPorts;
const clock = { nextWakeMs: async () => 1, sleep: async () => undefined };
function vocabulary(events: string[], fail = false): MatchingVocabularies {
  return { snapshot: () => { throw new Error('unused'); }, load: async () => { events.push('vocabulary'); if (fail) throw new Error('load failed');
    return {} as ReturnType<MatchingVocabularies['snapshot']>; }, refreshEquivalences: async () => { throw new Error('unused'); },
    rebuild: async () => { throw new Error('unused'); } };
}
function fakeLoop(events: string[]): EngineLoop {
  let release!: () => void; const running = new Promise<void>((resolve) => { release = resolve; });
  return { run: () => { events.push('loop-run'); return running; }, stop: () => { events.push('loop-stop'); release(); },
    status: () => ({ running: true, discovery: { iterations: 0, lastIterationAt: null, lastStageFailures: [], lastWakeMs: null,
      lastDue: 0, lastUnitsRun: 0, lastSuccessfulPlatforms: [], lastFailedPlatforms: [] },
      judgment: { iterations: 0, lastIterationAt: null, lastStageFailures: [], lastWakeMs: null } }) };
}

test('engine lock loser waits without vocabularies, hooks, sources, or loop', async () => {
  const events: string[] = [];
  const ownership = await startEngineOwnership({ store: { tryAcquireSingletonLock: async () => null },
    sources: { close: async () => { events.push('sources-close'); } },
    extensions: { startupHooks: [() => { events.push('startup'); }], shutdownHooks: [() => { events.push('shutdown'); }] },
    vocabularies: vocabulary(events), ports: emptyPorts, clocks: { discovery: clock, judgment: clock },
    createLoop: () => fakeLoop(events), retryDelayMs: 1 });
  assert.equal(ownership.ownsLock, false); assert.equal(ownership.status().state, 'waiting');
  assert.deepEqual(events, []); await ownership.stop();
});

test('lock holder loads state, starts hooks/lanes, and shuts down in required order once', async () => {
  const events: string[] = [];
  const ownership = await startEngineOwnership({ store: { tryAcquireSingletonLock: async () => {
      events.push('lock'); return { lost: new Promise(() => undefined), release: async () => { events.push('release'); } };
    } },
    sources: { close: async () => { events.push('sources-close'); } },
    extensions: { startupHooks: [() => { events.push('startup-1'); }, () => { events.push('startup-2'); }],
      shutdownHooks: [() => { events.push('shutdown-1'); }, () => { events.push('shutdown-2'); }] },
    vocabularies: vocabulary(events), ports: emptyPorts, clocks: { discovery: clock, judgment: clock },
    createLoop: () => fakeLoop(events) });
  assert.equal(ownership.ownsLock, true);
  assert.deepEqual(events, ['lock', 'vocabulary', 'startup-1', 'startup-2', 'loop-run']);
  await ownership.stop(); await ownership.stop();
  assert.deepEqual(events.slice(5), ['loop-stop', 'release', 'sources-close', 'shutdown-2', 'shutdown-1']);
});

test('startup failure closes sources, runs shutdown hooks, and releases lock', async () => {
  const events: string[] = [];
  await assert.rejects(startEngineOwnership({ store: { tryAcquireSingletonLock: async () => ({
      lost: new Promise(() => undefined), release: async () => { events.push('release'); } }) },
    sources: { close: async () => { events.push('sources-close'); } },
    extensions: { startupHooks: [], shutdownHooks: [() => { events.push('shutdown'); }] }, vocabularies: vocabulary(events, true),
    ports: emptyPorts, clocks: { discovery: clock, judgment: clock }, createLoop: () => fakeLoop(events) }), /load failed/u);
  assert.deepEqual(events, ['vocabulary', 'sources-close', 'shutdown', 'release']);
});

test('engine retries contention and lease loss without reinitializing providers or overlapping loops', async () => {
  const events: string[] = []; let attempts = 0; let loseFirst!: (error: Error) => void;
  const firstLost = new Promise<Error>((resolve) => { loseFirst = resolve; });
  const leases = [
    { lost: firstLost, release: async () => { events.push('release-1'); } },
    { lost: new Promise<Error>(() => undefined), release: async () => { events.push('release-2'); } },
  ];
  const ownership = await startEngineOwnership({ store: { tryAcquireSingletonLock: async () => {
      attempts += 1; events.push(`lock-${attempts}`); return attempts === 1 ? null : leases[attempts - 2] ?? leases[1]!;
    } }, sources: { close: async () => { events.push('sources-close'); } },
    extensions: { startupHooks: [() => { events.push('startup'); }], shutdownHooks: [() => { events.push('shutdown'); }] },
    vocabularies: vocabulary(events), ports: emptyPorts, clocks: { discovery: clock, judgment: clock },
    createLoop: () => fakeLoop(events), retryDelayMs: 0, sleep: async () => undefined });
  while (events.filter((event) => event === 'loop-run').length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ownership.status().state, 'running');
  loseFirst(new Error('postgres://must-not-log'));
  while (events.filter((event) => event === 'loop-run').length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event === 'vocabulary').length, 1);
  assert.equal(events.filter((event) => event === 'startup').length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith('loop-')), ['loop-run', 'loop-stop', 'loop-run']);
  await ownership.stop();
  assert.equal(events.filter((event) => event === 'sources-close').length, 1);
  assert.equal(events.filter((event) => event === 'shutdown').length, 1);
});
