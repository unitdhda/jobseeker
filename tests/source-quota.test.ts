import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applySourceQuota, sourceQuotaFor, type VacancyCandidate } from '../src/database.ts';

type Pooled = VacancyCandidate & { sourceRank: number };

function candidate(source: string, sourceId: string, combinedScore: number, sourceRank: number): Pooled {
  return { source, sourceId, url: `https://example.test/${sourceId}`, searchName: 'q', title: sourceId,
    summary: '', publishedAt: '2026-08-01T00:00:00.000Z', listingHash: sourceId, status: 'discovered',
    attempts: 0, combinedScore, sourceRank };
}

/** The pre-quota failure: one source outscores every other and takes the whole batch. */
function dominatedPool(): Pooled[] {
  const pool: Pooled[] = [];
  for (let rank = 1; rank <= 10; rank++) pool.push(candidate('hirehi', `h${rank}`, 90 - rank, rank));
  for (let rank = 1; rank <= 10; rank++) pool.push(candidate('habr', `a${rank}`, 40 - rank, rank));
  for (let rank = 1; rank <= 10; rank++) pool.push(candidate('rabota', `r${rank}`, 20 - rank, rank));
  return pool;
}

test('a dominant source no longer takes every normalization slot', () => {
  const selected = applySourceQuota(dominatedPool(), 9, 3);
  const bySource = new Map<string, number>();
  for (const item of selected) bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
  assert.equal(selected.length, 9);
  assert.deepEqual([...bySource.entries()].sort(), [['habr', 3], ['hirehi', 3], ['rabota', 3]]);
});

test('within its quota each source contributes its best-scoring candidates', () => {
  const selected = applySourceQuota(dominatedPool(), 9, 3);
  const habr = selected.filter((item) => item.source === 'habr').map((item) => item.sourceId);
  assert.deepEqual(habr, ['a1', 'a2', 'a3'], 'quota must take the top of each source, not an arbitrary slice');
});

test('leftover slots go to the best remaining candidates regardless of source', () => {
  // Only one rabota candidate exists, so two slots remain after the quota pass.
  const pool = [
    ...Array.from({ length: 5 }, (_unused, index) => candidate('hirehi', `h${index + 1}`, 90 - index, index + 1)),
    ...Array.from({ length: 5 }, (_unused, index) => candidate('habr', `a${index + 1}`, 40 - index, index + 1)),
    candidate('rabota', 'r1', 10, 1),
  ];
  const selected = applySourceQuota(pool, 8, 2);
  assert.equal(selected.length, 8, 'capacity must not be wasted when a source is short of its quota');
  const hirehi = selected.filter((item) => item.source === 'hirehi').length;
  assert.ok(hirehi > 2, 'a strong source should win the spare slots');
  assert.ok(selected.some((item) => item.source === 'rabota'), 'the thin source still keeps its guaranteed slot');
});

test('selection never exceeds capacity or repeats a candidate', () => {
  const selected = applySourceQuota(dominatedPool(), 5, 3);
  assert.equal(selected.length, 5);
  assert.equal(new Set(selected.map((item) => `${item.source}:${item.sourceId}`)).size, 5);
  // The pooled rank is an internal detail and must not leak into the returned candidate.
  assert.ok(!Object.hasOwn(selected[0]!, 'sourceRank'));
});

test('an empty or short pool is returned as-is', () => {
  assert.deepEqual(applySourceQuota([], 10, 3), []);
  assert.equal(applySourceQuota([candidate('habr', 'a1', 5, 1)], 10, 3).length, 1);
});

test('the default quota spreads the batch across configured platforms', () => {
  assert.equal(sourceQuotaFor(10, 4), 3);
  assert.equal(sourceQuotaFor(10, 8), 2);
  assert.equal(sourceQuotaFor(2, 8), 1, 'every source keeps at least one guaranteed slot');
  assert.equal(sourceQuotaFor(10, 0), 10, 'no configured platforms must not divide by zero');
});
