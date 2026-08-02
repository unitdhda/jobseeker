import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptRuntimeState, encryptRuntimeState } from '../src/lib/encrypted-state-store.ts';

const originalKey = process.env.RUNTIME_STATE_ENCRYPTION_KEY;

test.after(() => {
  if (originalKey == null) delete process.env.RUNTIME_STATE_ENCRYPTION_KEY;
  else process.env.RUNTIME_STATE_ENCRYPTION_KEY = originalKey;
});

test('runtime state is encrypted with path-bound authentication', () => {
  process.env.RUNTIME_STATE_ENCRYPTION_KEY = '11'.repeat(32);
  const plaintext = Buffer.from('private state');
  const encrypted = encryptRuntimeState('oauth/codex.json', plaintext);
  assert.notDeepEqual(Buffer.from(encrypted), plaintext);
  assert.deepEqual(Buffer.from(decryptRuntimeState('oauth/codex.json', encrypted)), plaintext);
  assert.throws(() => decryptRuntimeState('oauth/other.json', encrypted), /authentication failed/);
});

test('runtime-state paths and keys are validated', () => {
  process.env.RUNTIME_STATE_ENCRYPTION_KEY = '22'.repeat(32);
  assert.throws(() => encryptRuntimeState('../secret', Buffer.alloc(0)), /path is invalid/);
  process.env.RUNTIME_STATE_ENCRYPTION_KEY = 'short';
  assert.throws(() => encryptRuntimeState('oauth/codex.json', Buffer.alloc(0)), /32-byte hexadecimal key/);
});
