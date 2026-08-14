import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedChart, usageStatus } from '../src/observability.ts';

test('usage chart is a fixed 25-point dual axis with independent scaling', () => {
  const chart = fixedChart(Array.from({ length: 30 }, (_, index) => ({ primary: index, secondary: index === 29 ? 1000 : 0 })));
  assert.equal([...chart.primary].length, 25); assert.equal([...chart.secondary].length, 25);
  assert.notEqual(chart.primary, chart.secondary); assert.equal(chart.secondary.at(-1), '█');
  assert.throws(() => fixedChart([], 24), /exactly 25/u);
});

test('usage status localizes totals and emits bounded chart lines', () => {
  const hours = Array.from({ length: 25 }, (_, index) => ({ at: new Date(index * 3600000), tokens: index * 100, costUsd: index / 10 }));
  const output = usageStatus({ turns24h: 10, turnsTotal: 20, tokens24h: 1000, tokensTotal: 5000,
    inputTokens24h: 600, inputTokensTotal: 3000, outputTokens24h: 400, outputTokensTotal: 2000,
    cacheReadTokens24h: 300, cacheReadTokensTotal: 1500, cacheWriteTokens24h: 100, cacheWriteTokensTotal: 500,
    cost24h: 1.5, costTotal: 9.5, hours }, 'en');
  assert.equal(output.length, 1); assert.match(output[0]!, /Usage — 24 hours/u); assert.match(output[0]!, /Tokens/u);
  assert.match(output[0]!, /Input.*output/u); assert.match(output[0]!, /Cache read.*write/u);
  assert.match(output[0]!, /Money — right axis/u); assert.match(output[0]!, /<pre>/u);
  assert.ok(output[0]!.length < 4096);
});
