import assert from 'node:assert/strict';
import test from 'node:test';
import { digestPageMeta, digestPageSize, digestPageSlice, formatApplyIdWithUniquePrefix, normalizeApplyIdPrefix,
  shortestUniqueApplyPrefixes } from '../src/telegram/digest-page.ts';

test('digest uses ten items per page and clamps stale navigation to the last page', () => {
  assert.equal(digestPageSize, 10);
  assert.deepEqual(digestPageMeta(25, 0), { page: 0, pageCount: 3, total: 25, hasPrevious: false, hasNext: true });
  assert.deepEqual(digestPageMeta(25, 99), { page: 2, pageCount: 3, total: 25, hasPrevious: true, hasNext: false });
  const page = digestPageSlice(Array.from({ length: 25 }, (_, index) => index), 1);
  assert.deepEqual(page.items, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(digestPageMeta(0, 0), { page: 0, pageCount: 1, total: 0, hasPrevious: false, hasNext: false });
});

test('apply IDs use shortest prefixes across the complete scored history', () => {
  const prefixes = shortestUniqueApplyPrefixes(['abcdef', 'abcxyz', 'zbcdef', 'qwerty']);
  assert.deepEqual({ ...prefixes }, { abcdef: 'abcd', abcxyz: 'abcx', zbcdef: 'z', qwerty: 'q' });
  assert.equal(formatApplyIdWithUniquePrefix('abcdef', ['abcdef', 'abcxyz']), '<b>abcd</b>ef');
  assert.equal(formatApplyIdWithUniquePrefix('zbcdef', ['abcdef', 'zbcdef']), '<b>z</b>bcdef');
  assert.equal(formatApplyIdWithUniquePrefix('abcdea', ['abcdef', 'abcdea']), '<b>abcdea</b>');
  assert.throws(() => shortestUniqueApplyPrefixes(['abcdef', 'abcdef']), /unique/u);
  assert.throws(() => shortestUniqueApplyPrefixes(['ABCDEF']), /Invalid/u);
});

test('match-code normalization trims and lowercases one to six ASCII letters only', () => {
  assert.equal(normalizeApplyIdPrefix('  BQE  '), 'bqe'); assert.equal(normalizeApplyIdPrefix('abcdef'), 'abcdef');
  for (const invalid of ['', 'abcdefg', 'ab-1', 'абв', '   ']) assert.equal(normalizeApplyIdPrefix(invalid), null);
});
