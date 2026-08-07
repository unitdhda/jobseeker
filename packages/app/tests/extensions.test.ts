import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensionsFrom } from '../src/extensions.ts';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jobseeker-extensions-'));
}

test('extensions register providers and hooks through the injected api, in name order', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'b-sources.mjs'), `
      export default function register(api) {
        api.registerSourceProvider(api.sources.createSourceProvider({
          id: 'fake', name: 'Fake', hosts: ['fake.example'],
          schema: { kind: 'schema' }, template: () => ({}),
          discover: async () => ({ searches: 0, users: 0, seen: 0, discovered: 0 }),
          normalize: async () => new Map(),
        }));
        api.onStartup(() => {});
        api.onShutdown(() => {});
      }
    `);
    await mkdir(join(root, 'a-model'));
    await writeFile(join(root, 'a-model', 'index.mjs'), `
      export default function register(api) {
        api.registerAiProvider({ id: 'faux-extension', models: [] });
        api.log('registered');
      }
    `);
    await writeFile(join(root, 'README.md'), 'not an extension');
    const loaded = await loadExtensionsFrom(root);
    assert.deepEqual(loaded.names, ['a-model', 'b-sources.mjs']);
    assert.equal(loaded.sourceProviders.length, 1);
    assert.equal(loaded.sourceProviders[0]!.id, 'fake');
    assert.deepEqual(loaded.sourceProviders[0]!.hosts, ['fake.example']);
    assert.equal(loaded.aiProviders.length, 1);
    assert.equal(loaded.startupHooks.length, 1);
    assert.equal(loaded.shutdownHooks.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a module without a register function is a hard startup error, not a silent skip', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'broken.mjs'), 'export const answer = 42;');
    await assert.rejects(() => loadExtensionsFrom(root), /must default-export a register\(api\) function/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing extensions directory means an empty composition, not a crash', async () => {
  const loaded = await loadExtensionsFrom(join(tmpdir(), 'jobseeker-extensions-nonexistent'));
  assert.deepEqual(loaded.names, []);
  assert.deepEqual(loaded.sourceProviders, []);
});
