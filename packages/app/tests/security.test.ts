import assert from 'node:assert/strict';
import test from 'node:test';
import { readResponseBytes } from '../src/http.ts';
import { createSourceUrlPolicy } from '@jobseeker/sources';
import { hhSource } from '../src/vacancies/providers/hh.ts';
import { hireHiSource } from '../src/vacancies/providers/hirehi.ts';
import { errorMessage } from '../src/observability.ts';

test('source URLs are restricted to HTTPS source allowlists', () => {
  const policy = createSourceUrlPolicy([hhSource(), hireHiSource()]);
  assert.equal(policy.safeVacancyUrl('hh', 'https://hh.ru/vacancy/123'), 'https://hh.ru/vacancy/123');
  assert.equal(policy.safeVacancyUrl('hirehi', 'https://hirehi.ru/frontend/job-123'), 'https://hirehi.ru/frontend/job-123');
  assert.throws(() => policy.sourceUrl('hh', 'http://hh.ru/vacancy/123'), /Unsafe/);
  assert.throws(() => policy.sourceUrl('hh', 'https://example.com/vacancy/123'), /Unexpected/);
  assert.throws(() => policy.sourceUrl('hh', 'https://user:password@hh.ru/vacancy/123'), /Unsafe/);
  assert.throws(() => policy.sourceUrl('hirehi', 'https://example.com/frontend/job-123'), /Unexpected/);
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
