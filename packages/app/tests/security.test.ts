import assert from 'node:assert/strict';
import test from 'node:test';
import { readResponseBytes } from '../src/http.ts';
import { errorMessage } from '../src/observability.ts';

// The URL-policy allowlist test moved to packages/sources: it exercises example providers, which the application
// no longer carries.

test('response reader enforces declared and streamed byte limits', async () => {
  await assert.rejects(() => readResponseBytes(new Response('12345', { headers: { 'content-length': '5' } }), 4), /exceeds/);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); controller.close(); },
  });
  await assert.rejects(() => readResponseBytes(new Response(stream), 5), /exceeds/);
});

test('logged error summaries redact credentials and personal contacts', () => {
  const message = errorMessage(new Error('Bearer abcdefghijklmnopqrstuvwxyz token=secret user@example.com'));
  assert.doesNotMatch(message, /abcdefghijklmnopqrstuvwxyz|secret|user@example\.com/);
});
