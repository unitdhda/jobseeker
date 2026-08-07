import assert from 'node:assert/strict';
import test from 'node:test';
import * as sources from '@jobseeker/sources';
import { AdaptiveTaskPool, mapConcurrent } from '@jobseeker/engine/concurrency';
import { initToolkit } from './toolkit.ts';
import { hhPublishedAt, hhSource } from './hh.ts';

// Tests run from the dev checkout, where the workspace packages resolve; the running app injects these instead.
initToolkit({ sources, concurrency: { AdaptiveTaskPool } });
void mapConcurrent;

test('HH provider factories retain independent configuration', async () => {
  const first = hhSource({ areaId: '1' });
  const second = hhSource({ areaId: '2' });
  assert.equal(first.template().capabilities.configuredDefaultArea, '1');
  assert.equal(second.template().capabilities.configuredDefaultArea, '2');
  assert.deepEqual(first.hosts, ['hh.ru', 'www.hh.ru']);
  await Promise.all([first.close?.({} as never), second.close?.({} as never)]);
});


test('hh reads the advert’s own publication date rather than the time it was read', () => {
  const posting = (extra: string) => `<html><body>${extra}<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Data Scientist',
    datePosted: '2026-07-29T11:39:03.741+03:00' })}</script></body></html>`;
  assert.equal(hhPublishedAt(posting(''), ''), '2026-07-29T08:39:03.741Z');
  // The visible line is the fallback when the page ships no JobPosting block.
  assert.equal(hhPublishedAt('<html><body></body></html>', 'Вакансия опубликована 29 июля 2026 в Москве'),
    '2026-07-29T00:00:00.000Z');
  assert.equal(hhPublishedAt('<html><body></body></html>', 'Вакансия опубликована 1 мая 2026 в Москве'),
    '2026-05-01T00:00:00.000Z');
  // No date at all must be reported as unknown, never silently replaced with the current time.
  assert.equal(hhPublishedAt('<html><body></body></html>', 'Описание вакансии'), null);
  assert.equal(hhPublishedAt('<html><body></body></html>', 'Вакансия опубликована 3 сентебря 2026'), null);
});
