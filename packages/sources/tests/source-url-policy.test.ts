import './toolkit-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceUrlPolicy } from '../src/index.ts';
import { hireHiSource } from '../examples/hirehi.ts';
import { mtsSource } from '../examples/mts.ts';

test('source URLs are restricted to HTTPS source allowlists', () => {
  const policy = createSourceUrlPolicy([mtsSource(), hireHiSource()]);
  assert.equal(policy.safeVacancyUrl('mts', 'https://job.mts.ru/vacancy/123'), 'https://job.mts.ru/vacancy/123');
  assert.equal(policy.safeVacancyUrl('hirehi', 'https://hirehi.ru/frontend/job-123'), 'https://hirehi.ru/frontend/job-123');
  assert.throws(() => policy.sourceUrl('mts', 'http://job.mts.ru/vacancy/123'), /Unsafe/);
  assert.throws(() => policy.sourceUrl('mts', 'https://example.com/vacancy/123'), /Unexpected/);
  assert.throws(() => policy.sourceUrl('mts', 'https://user:password@job.mts.ru/vacancy/123'), /Unsafe/);
  assert.throws(() => policy.sourceUrl('hirehi', 'https://example.com/frontend/job-123'), /Unexpected/);
});
