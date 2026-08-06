import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMessageLines, scraperStatusMessage, scraperTimelineChart } from '../src/telegram/format.ts';
import type { ScraperSummary } from '@jobseeker/store';

const start = Date.parse('2026-08-02T12:00:00Z');
const hourly = Array.from({ length: 25 }, (_, index) => ({
  at: new Date(start + index * 3_600_000).toISOString(), scored: 40, normalized: 12,
}));

const summary: ScraperSummary = {
  hourly,
  sources: [
    { source: 'hh', discovered24h: 320, normalized24h: 45, failed: 12, queued: 30, closed24h: 4, scored24h: 9 },
    { source: 'geekjob', discovered24h: 0, normalized24h: 0, failed: 0, queued: 0, closed24h: 0, scored24h: 0 },
  ],
  units: [{ platform: 'hh', units: 68, overdue: 5, cadenceMin: 30, cadenceMax: 720, lastNoveltyAt: hourly[24]!.at }],
  matched24h: 57, scored24h: 21,
  errors: [{ error: 'HH browser normalization exceeded 180 seconds.', count: 12 }],
};

test('scraper timeline keeps the usage chart geometry with its own legend', () => {
  const chart = scraperTimelineChart(hourly, '+00:00');
  const lines = chart.split('\n');
  assert.equal(lines.length, 19);
  assert.match(lines[0]!, /Оценки/u);
  assert.match(lines[0]!, /Распознано/u);
  const plotRows = lines.slice(3, 15);
  const left = plotRows[0]!.indexOf('│'), right = plotRows[0]!.lastIndexOf('│');
  assert.equal(right - left - 1, 49, 'two columns per hour across 24 hours');
  // Flat series: seven four-hourly markers each, no money formatting anywhere on the right axis.
  assert.equal((chart.match(/●/gu) ?? []).length, 8);
  assert.equal((chart.match(/○/gu) ?? []).length, 8);
  assert.doesNotMatch(chart, /\$/u);
});

test('scraper timeline demands the full 25 hourly points', () => {
  assert.throws(() => scraperTimelineChart(hourly.slice(0, 10), '+00:00'));
});

test('the summary reports totals, per-source rows, units, and parser errors', () => {
  const message = scraperStatusMessage(summary);
  assert.match(message, /320/u);
  assert.match(message, /оценок 9/u);
  assert.match(message, /hh/u);
  assert.match(message, /68/u);
  assert.match(message, /30–720/u);
  assert.match(message, /HH browser normalization/u);
  assert.match(message, /×12/u);
  assert.match(message, /57/u);
});

test('a source with no activity is still listed rather than silently dropped', () => {
  // A dead adapter is exactly what this command exists to expose.
  assert.match(scraperStatusMessage(summary), /geekjob/u);
});

test('long owner messages split on line boundaries under the Telegram limit', () => {
  const line = '• source: 100 новых · 100 распознано · очередь 5 · сбоев 0 · закрыто 1 · оценок 9';
  const text = Array.from({ length: 120 }, (_, index) => `${line} ${index}`).join('\n');
  const chunks = chunkMessageLines(text, 3_900);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 3_900));
  assert.equal(chunks.join('\n'), text);
  assert.deepEqual(chunkMessageLines('короткий статус', 3_900), ['короткий статус']);
});
