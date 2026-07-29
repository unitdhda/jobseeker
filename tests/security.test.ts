import assert from 'node:assert/strict';
import test from 'node:test';
import { readResponseBytes } from '../src/lib/safe-http.ts';
import { safeVacancyUrl, sourceUrl } from '../src/lib/url-security.ts';
import { errorMessage } from '../src/lib/logging.ts';

test('source URLs are restricted to HTTPS source allowlists', () => {
  assert.equal(safeVacancyUrl('hh', 'https://hh.ru/vacancy/123'), 'https://hh.ru/vacancy/123');
  assert.throws(() => sourceUrl('hh', 'http://hh.ru/vacancy/123'), /Unsafe/);
  assert.throws(() => sourceUrl('hh', 'https://example.com/vacancy/123'), /Unexpected/);
  assert.throws(() => sourceUrl('hh', 'https://user:password@hh.ru/vacancy/123'), /Unsafe/);
});

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
