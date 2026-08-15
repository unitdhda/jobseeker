import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCurrencyCode, parseSourceKey, parseSourceVacancyId, parseUserId } from '@jobseeker/engine/contracts';
import type { ScoredVacancy } from '@jobseeker/store';
import { escapeHtml, formatDate, formatDigestVacancy, formatDuration, formatNumber, formatSalary,
  formatStatus, formatTime, splitTelegramHtml, telegramLink } from '../src/telegram/format.ts';

const vacancy: ScoredVacancy = {
  id: 1, applyId: 'abcdef', lifecycleStatus: 'normalized', userId: parseUserId('1'), score: 87,
  source: parseSourceKey('test'), sourceId: parseSourceVacancyId('1'), name: '<Backend & API>', employer: 'A "Corp"', area: 'Remote > Office',
  salary: { from: 100000, to: 150000, currency: parseCurrencyCode('RUB'), gross: false, period: 'month' },
  experience: { kind: 'unspecified' }, employment: 'full-time', schedule: 'standard', workFormat: 'remote',
  description: 'x', keySkills: [], url: new URL('https://example.test/job?a=1&b=2'), publishedAt: new Date('2025-01-02T03:04:00Z'),
  sourceQuery: 'private query', primaryTrack: 'Backend', summary: '<strong summary>', reasons: ['Uses TypeScript & APIs'],
  gaps: ['No <domain> evidence'], explanation: null,
};

test('HTML and link formatting escapes user strings and query-bearing URLs', () => {
  assert.equal(escapeHtml('<a "x">&'), '&lt;a &quot;x&quot;&gt;&amp;');
  assert.equal(telegramLink('<open>', vacancy.url), '<a href="https://example.test/job?a=1&amp;b=2">&lt;open&gt;</a>');
  const formatted = formatDigestVacancy(vacancy, ['abcdef', 'abcxyz'], 'en');
  assert.doesNotMatch(formatted, /<Backend|<strong|<domain>/u);
  assert.match(formatted, /<b>abcd<\/b>ef · <b>&lt;Backend &amp; API&gt;<\/b>/u);
  assert.match(formatted, /TypeScript &amp; APIs/u);
  assert.equal(formatted.includes('private query'), false);
});

test('number, salary, date, time, duration, and status respect reader locale', () => {
  assert.notEqual(formatNumber(1234567.5, 'ru', 1), formatNumber(1234567.5, 'en', 1));
  assert.match(formatSalary(vacancy.salary, 'ru'), /100.{0,2}000–150.{0,2}000 RUB на руки в месяц/u);
  assert.match(formatSalary(vacancy.salary, 'en'), /100,000–150,000 RUB net per month/u);
  assert.equal(formatSalary(null, 'en'), 'salary not specified');
  assert.ok(formatDate(vacancy.publishedAt, 'en', 'UTC').length > 0); assert.match(formatTime(vacancy.publishedAt, 'en', 'UTC'), /03:04|03\.04/u);
  assert.equal(formatDuration(90_000, 'ru'), '2 мин'); assert.equal(formatDuration(90_000, 'en'), '2 min');
  assert.equal(formatStatus('running', 'en'), 'running'); assert.equal(formatStatus('waiting', 'en'), 'waiting for ownership');
  assert.equal(formatStatus('recovering', 'ru'), 'восстанавливается'); assert.equal(formatStatus('off', 'ru'), 'выключен');
});

test('message splitting preserves line boundaries and rejects an oversized indivisible line', () => {
  assert.deepEqual(splitTelegramHtml(['abc', 'def', 'ghi'], 7), ['abc\ndef', 'ghi']);
  assert.throws(() => splitTelegramHtml(['12345678'], 7), /line exceeds/u);
});
