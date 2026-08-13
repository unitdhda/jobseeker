import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Credential, Provider } from '@earendil-works/pi-ai';
import { createCredentialStore } from '../src/ai-auth.ts';
import { composeAiModels } from '../src/ai.ts';
import type { ExtensionState } from '../src/extensions.ts';

const identityLock = async <T>(_: string, operation: () => Promise<T>): Promise<T> => operation();
function memoryState(initial: Uint8Array | null = null): ExtensionState & { value: Uint8Array | null } {
  return {
    value: initial, configured: () => true,
    async get() { return this.value; }, async put(_path, value) { this.value = value.slice(); }, async delete() { this.value = null; },
  };
}
const unavailableState: ExtensionState = { configured: () => false, get: async () => null,
  put: async () => { throw new Error('unused'); }, delete: async () => { throw new Error('unused'); } };

test('credential operations serialize through one process chain and whole-document advisory lock', async () => {
  const state = memoryState(); let active = 0; let maximum = 0; const lockKeys: string[] = [];
  const store = createCredentialStore({ state, filePath: 'unused', withAdvisoryLock: async (key, operation) => {
    lockKeys.push(key); active += 1; maximum = Math.max(maximum, active);
    try { return await operation(); } finally { active -= 1; }
  } });
  await Promise.all([
    store.modify('anthropic', async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { type: 'api_key', key: 'first' }; }),
    store.modify('openai', async () => ({ type: 'oauth', refresh: 'refresh', access: 'access', expires: 123 })),
  ]);
  assert.equal(maximum, 1); assert.ok(lockKeys.every((key) => key === 'jobseeker-ai-credentials'));
  assert.deepEqual((await store.list()).map((item) => item.providerId), ['anthropic', 'openai']);
  assert.equal((await store.read('anthropic') as Extract<Credential, { type: 'api_key' }>).key, 'first');
  const before = state.value;
  const unchanged = await store.modify('anthropic', async () => undefined);
  assert.equal((unchanged as Extract<Credential, { type: 'api_key' }>).key, 'first'); assert.equal(state.value, before);
  await store.delete('anthropic'); assert.equal(await store.read('anthropic'), undefined);
});

test('local credentials use atomic mode-0600 provider-keyed JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-auth-')); const filePath = join(root, 'nested', 'auth.json');
  try {
    const store = createCredentialStore({ state: unavailableState, filePath, withAdvisoryLock: identityLock });
    await store.modify('provider', async () => ({ type: 'api_key', key: 'private-key', env: { ACCOUNT: 'a' } }));
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { provider: { type: 'api_key', key: 'private-key', env: { ACCOUNT: 'a' } } });
    assert.equal((await store.read('provider') as Extract<Credential, { type: 'api_key' }>).key, 'private-key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stored credential wins over environment auth during Pi-AI resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-auth-resolution-')); const filePath = join(root, 'auth.json');
  try {
    const credentials = createCredentialStore({ state: unavailableState, filePath, withAdvisoryLock: identityLock });
    await credentials.modify('custom', async () => ({ type: 'api_key', key: 'stored-key' }));
    const provider: Provider = { id: 'custom', name: 'Custom', auth: { apiKey: { name: 'Custom key',
      resolve: async ({ credential, ctx }) => ({ auth: { apiKey: credential?.key ?? await ctx.env('CUSTOM_KEY') } }) } },
      getModels: () => [], stream: () => { throw new Error('unused'); }, streamSimple: () => { throw new Error('unused'); } };
    const models = composeAiModels([provider], { builtins: [], credentials, env: { CUSTOM_KEY: 'environment-key' } });
    assert.equal((await models.getAuth('custom'))?.auth.apiKey, 'stored-key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed credential documents fail without echoing secret values', async () => {
  const state = memoryState(new TextEncoder().encode(JSON.stringify({ provider: { type: 'api_key', key: 123, leaked: 'TOP_SECRET' } })));
  const store = createCredentialStore({ state, filePath: 'unused', withAdvisoryLock: identityLock });
  await assert.rejects(store.read('provider'), (error: unknown) => error instanceof Error
    && /Invalid API-key credential/u.test(error.message) && !error.message.includes('TOP_SECRET'));
  await assert.rejects(store.read('../provider'), /provider ID/u);
});
