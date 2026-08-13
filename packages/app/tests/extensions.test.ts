import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadExtensionsFrom } from '../src/extensions.ts';

async function fixture(): Promise<string> { return mkdtemp(join(tmpdir(), 'jobseeker-extensions-')); }
const sourceModule = (id: string, extra = '') => `export default async function(api) {
  api.registerSourceProvider(Object.freeze({
    id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, hosts: Object.freeze(['${id}.example.test']),
    schema: Object.freeze({}),
    template: () => ({ platform: '${id}', version: 1, purpose: 'test', jsonShape: {}, capabilities: {}, rules: [] }),
    discover: async () => ({ searches: 0, users: 0, seen: 0, discovered: 0 }),
    normalize: async () => new Map(),
  }));
  ${extra}
}`;

test('loader discovers deterministic top-level modules and subdirectory indexes only', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'b.mjs'), sourceModule('b'));
    await writeFile(join(root, 'a.mjs'), sourceModule('a', "api.onStartup(() => {}); api.onShutdown(() => {}); api.log('ready');"));
    await writeFile(join(root, '.hidden.mjs'), sourceModule('hidden'));
    await writeFile(join(root, 'ignored.txt'), 'not a module');
    await writeFile(join(root, 'types.d.ts'), 'export {};');
    await mkdir(join(root, 'c')); await writeFile(join(root, 'c', 'index.mjs'), sourceModule('c'));
    await mkdir(join(root, 'unrelated')); await writeFile(join(root, 'unrelated', 'other.mjs'), sourceModule('other'));
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'index.mjs'), sourceModule('dependency'));
    const logs: string[] = [];
    const loaded = await loadExtensionsFrom(root, { env: { TOKEN: 'snapshot' }, log: (message) => logs.push(message) });
    assert.deepEqual(loaded.names, ['a.mjs', 'b.mjs', 'c']);
    assert.deepEqual(loaded.sourceProviders.map((provider) => provider.id), ['a', 'b', 'c']);
    assert.equal(loaded.startupHooks.length, 1); assert.equal(loaded.shutdownHooks.length, 1);
    assert.deepEqual(logs, ['[extension a.mjs] ready']);
    assert.equal(Object.isFrozen(loaded.sourceProviders), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing extension directory is an empty composition', async () => {
  const root = join(tmpdir(), `jobseeker-missing-${Date.now()}`);
  const loaded = await loadExtensionsFrom(root, { env: {} });
  assert.deepEqual(loaded.names, []); assert.deepEqual(loaded.sourceProviders, []); assert.deepEqual(loaded.aiProviders, []);
});

test('every module requires a default register function', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'bad.mjs'), 'export const value = 1;');
    await assert.rejects(() => loadExtensionsFrom(root, { env: {} }), /must default-export/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('duplicate source and AI provider IDs fail composition', async () => {
  const sourceRoot = await fixture();
  try {
    await writeFile(join(sourceRoot, 'a.mjs'), sourceModule('same'));
    await writeFile(join(sourceRoot, 'b.mjs'), sourceModule('same'));
    await assert.rejects(() => loadExtensionsFrom(sourceRoot, { env: {} }), /Duplicate source provider ID/u);
  } finally { await rm(sourceRoot, { recursive: true, force: true }); }

  const aiRoot = await fixture();
  try {
    await writeFile(join(aiRoot, 'a.mjs'), `export default api => api.registerAiProvider({ id: 'same', models: [] });`);
    await writeFile(join(aiRoot, 'b.mjs'), `export default api => api.registerAiProvider({ id: 'same', models: [] });`);
    await assert.rejects(() => loadExtensionsFrom(aiRoot, { env: {} }), /Duplicate AI provider ID/u);
  } finally { await rm(aiRoot, { recursive: true, force: true }); }
});

test('environment is snapshotted and delayed registration is rejected', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'delayed.mjs'), `export let result;
      export default api => { result = { env: api.env, late: new Promise(resolve => setTimeout(() => {
        try { api.onStartup(() => {}); resolve('accepted'); } catch (error) { resolve(error.message); }
      }, 0)) }; };`);
    const env: Record<string, string | undefined> = { VALUE: 'before' };
    const loaded = await loadExtensionsFrom(root, { env });
    env.VALUE = 'after';
    const imported = await import(`${new URL(`file://${join(root, 'delayed.mjs')}`).href}?inspect`);
    // A separate module instance cannot expose loader state, so assert the frozen snapshot through a second fixture hook.
    assert.equal(loaded.names.length, 1);
    assert.equal(Object.isFrozen((await import(`${new URL(`file://${join(root, 'delayed.mjs')}`).href}?jobseeker=delayed.mjs`)).result.env), true);
    assert.match(await (await import(`${new URL(`file://${join(root, 'delayed.mjs')}`).href}?jobseeker=delayed.mjs`)).result.late, /after its register function completed/u);
    void imported;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('default state adapter is explicitly unconfigured', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'state.mjs'), `export let observed; export default async api => {
      observed = [api.state.configured(), await api.state.get('x')];
      try { await api.state.put('x', new Uint8Array()); } catch (error) { observed.push(error.message); }
    };`);
    await loadExtensionsFrom(root, { env: {} });
    const module = await import(`${new URL(`file://${join(root, 'state.mjs')}`).href}?jobseeker=state.mjs`);
    assert.deepEqual(module.observed.slice(0, 2), [false, null]);
    assert.match(module.observed[2], /not configured/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
