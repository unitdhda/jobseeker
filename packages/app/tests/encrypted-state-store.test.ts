import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createRuntimeState,
  decryptRuntimeState,
  encryptRuntimeState,
  runtimeStateConfigured,
  validateRuntimeStatePath,
} from '../src/runtime-state.ts';

const key = 'ab'.repeat(32);

test('AES-256-GCM binary envelope binds ciphertext to canonical object path', () => {
  const plaintext = new TextEncoder().encode('private state');
  const encrypted = encryptRuntimeState('oauth/codex.json', plaintext, key);
  assert.equal(new TextDecoder().decode(encrypted.slice(0, 4)), 'JSRS');
  assert.deepEqual(decryptRuntimeState('oauth/codex.json', encrypted, key), plaintext);
  assert.throws(() => decryptRuntimeState('oauth/other.json', encrypted, key), /authentication/u);
  const tampered = encrypted.slice(); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptRuntimeState('oauth/codex.json', tampered, key), /authentication/u);
});

test('legacy strict JSON envelope remains decryptable with path AAD', () => {
  const path = 'healthcheck/state.bin'; const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(path)); const ciphertext = Buffer.concat([cipher.update('legacy'), cipher.final()]);
  const envelope = new TextEncoder().encode(JSON.stringify({ version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  assert.equal(new TextDecoder().decode(decryptRuntimeState(path, envelope, key)), 'legacy');
  const extra = new TextEncoder().encode(JSON.stringify({ version: 1, iv: '', tag: '', ciphertext: '', extra: true }));
  assert.throws(() => decryptRuntimeState(path, extra, key), /JSON envelope/u);
});

test('runtime-state namespace rejects traversal, non-descendants, query syntax, and partial configuration', () => {
  assert.equal(validateRuntimeStatePath('browser/hh.tar.gz'), 'browser/hh.tar.gz');
  for (const path of ['oauth', 'other/file', 'oauth/../file', 'oauth//file', 'oauth/a?x=1', 'oauth\\file']) {
    assert.throws(() => validateRuntimeStatePath(path), /runtime-state|Runtime-state/u);
  }
  assert.equal(runtimeStateConfigured({ url: 'x', key: 'x', bucket: 'x', encryptionKey: key }), true);
  assert.equal(runtimeStateConfigured({ url: 'x', key: 'x' }), false);
  assert.throws(() => createRuntimeState({ url: 'https://state.test', key: 'secret' }), /requires/u);
});

test('Supabase-compatible adapter authenticates, encrypts, handles 404, and never exposes key in errors', async () => {
  const objects = new Map<string, Uint8Array>(); const seen: Array<{ url: string; init: RequestInit }> = [];
  const state = createRuntimeState({ url: 'https://state.test/base', key: 'super-secret-key', bucket: 'private', encryptionKey: key,
    fetch: async (input, init = {}) => {
      const url = String(input); seen.push({ url, init }); const method = init.method ?? 'GET';
      if (method === 'POST') { objects.set(url, Uint8Array.from(init.body as Uint8Array)); return new Response('', { status: 200 }); }
      if (method === 'DELETE') { objects.delete(url); return new Response('', { status: 200 }); }
      const value = objects.get(url); return value ? new Response(Uint8Array.from(value)) : new Response('', { status: 404 });
    } });
  assert.equal(state.configured(), true); assert.equal(await state.get('oauth/missing.json'), null);
  await state.put('oauth/codex.json', new TextEncoder().encode('credential document'));
  const restored = await state.get('oauth/codex.json'); assert.equal(new TextDecoder().decode(restored!), 'credential document');
  assert.match(seen[1]!.url, /\/storage\/v1\/object\/private\/oauth\/codex.json$/u);
  assert.equal(new Headers(seen[1]!.init.headers).get('authorization'), 'Bearer super-secret-key');
  assert.equal(new TextDecoder().decode(objects.values().next().value!).includes('credential document'), false);
  const failing = createRuntimeState({ url: 'https://state.test', key: 'super-secret-key', bucket: 'private', encryptionKey: key,
    fetch: async () => new Response('', { status: 500 }) });
  await assert.rejects(failing.get('oauth/codex.json'), (error: unknown) => error instanceof Error
    && /status 500/u.test(error.message) && !error.message.includes('super-secret-key'));
});
