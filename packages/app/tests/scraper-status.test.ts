import assert from 'node:assert/strict';
import test from 'node:test';
import { scraperStatus } from '../src/observability.ts';

test('scraper status contains every configured source including zero-row providers and fixed dual chart', () => {
  const output = scraperStatus({
    hours: Array.from({ length: 25 }, (_, index) => ({ at: new Date(), normalized: index, scored: 24 - index })),
    sources: [{ source: 'one', discovered24h: 5, normalized24h: 4, failed: 1, queued: 2, closed24h: 3, scored24h: 4 }],
    units: [{ platform: 'one', units: 3, overdue: 1, cadenceMin: 30, cadenceMax: 60, lastNoveltyAt: null }],
    normalization: { queued: 2, activeClaims: 3, expiredClaims: 4, undecodable: 5 }, matched24h: 10, scored24h: 8,
    parserErrors: [{ error: '<parser & error>', count: 2 }],
  }, ['one', 'two'], 'en');
  const text = output.join('\n');
  assert.match(text, /one: \+5 · parsed 4 · failed 1/u); assert.match(text, /two: \+0 · parsed 0 · failed 0/u);
  assert.match(text, /queued: 2 · active: 3 · expired: 4/u);
  assert.match(text, /&lt;parser &amp; error&gt;/u); assert.equal(text.includes('<parser & error>'), false);
  assert.match(text, /Search units/u); assert.match(text, /one: 3 · overdue 1 · cadence 30–60 min/u); assert.match(text, /<pre>/u);
  assert.match(text, /Scored — left axis/u); assert.match(text, /Parsed — right axis/u);
  const russian = scraperStatus({ hours: Array.from({ length: 25 }, () => ({ at: new Date(), normalized: 0, scored: 0 })),
    sources: [], units: [], normalization: { queued: 1, activeClaims: 2, expiredClaims: 3, undecodable: 4 },
    matched24h: 0, scored24h: 0, parserErrors: [] }, [], 'ru').join('\n');
  assert.match(russian, /Нормализация/u); assert.match(russian, /очередь: 1/u);
});

test('scraper output splits large source inventories below Telegram limit on line boundaries', () => {
  const sources = Array.from({ length: 200 }, (_, index) => `source-${index}-${'x'.repeat(20)}`);
  const output = scraperStatus({ hours: Array.from({ length: 25 }, (_, index) =>
    ({ at: new Date(index * 3_600_000), normalized: 0, scored: 0 })), sources: [], units: [],
    normalization: { queued: 0, activeClaims: 0, expiredClaims: 0, undecodable: 0 }, matched24h: 0, scored24h: 0, parserErrors: [] }, sources, 'en');
  assert.ok(output.length > 1); assert.ok(output.every((message) => message.length <= 4096));
});
