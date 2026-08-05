import assert from 'node:assert/strict';
import test from 'node:test';
import { digestPageMessage, digestPageSize } from '../src/telegram/format.ts';
import type { ScoredVacancy } from '@jobseeker/store';

function vacancy(index: number): ScoredVacancy {
  return { id: index, source: 'hh', sourceId: String(index), applyId: `aa${String(index).padStart(4, 'b')}`,
    name: `Вакансия <${index}>`, employer: 'Employer', area: 'Area', salaryFrom: null, salaryTo: null,
    salaryCurrency: null, salaryGross: null, experience: '', employment: '', schedule: '', workFormat: '',
    description: '', keySkills: [], url: `https://hh.ru/vacancy/${index}`, publishedAt: '2026-08-05T00:00:00Z',
    sourceQuery: '', contentHash: '', decision: 'scored', userId: 'u1', score: 70 - index };
}
const many = Array.from({ length: 23 }, (_, index) => vacancy(index));
const allIds = many.map((entry) => entry.applyId);

test('a page lists at most ten vacancies as links and names its position', () => {
  const { text, keyboard } = digestPageMessage(many.slice(0, digestPageSize), allIds, 0, 3);
  assert.equal((text.match(/<a href=/gu) ?? []).length, 10);
  assert.match(text, /1\/3/u);
  assert.match(text, /&lt;0&gt;/u, 'vacancy names are HTML-escaped');
  assert.ok(keyboard, 'several pages need navigation');
});

test('navigation goes exactly to the neighbour pages and stops at the edges', () => {
  const row = (page: number) => digestPageMessage(many.slice(page * 10, page * 10 + 10), allIds, page, 3)
    .keyboard!.inline_keyboard[0]! as { text: string; callback_data?: string }[];
  const first = row(0);
  assert.equal(first[0]!.callback_data, 'digest:noop', 'no page before the first');
  assert.equal(first[2]!.callback_data, 'digest:page:1');
  const middle = row(1);
  assert.equal(middle[0]!.callback_data, 'digest:page:0');
  assert.equal(middle[1]!.text, '2/3');
  assert.equal(middle[2]!.callback_data, 'digest:page:2');
  assert.equal(row(2)[2]!.callback_data, 'digest:noop', 'no page past the end');
});

test('a single page needs no keyboard at all', () => {
  const { keyboard } = digestPageMessage(many.slice(0, 3), allIds.slice(0, 3), 0, 1);
  assert.equal(keyboard, undefined);
});

test('apply-id prefixes stay unique against the whole digest, not just the visible page', () => {
  // Prefix resolution answers user replies, and the user may reply from any page.
  const { text } = digestPageMessage(many.slice(0, 10), allIds, 0, 3);
  const match = /^<b>([a-z0-9]+)<\/b>[a-z0-9]* · /mu.exec(text);
  assert.ok(match, 'every row starts with its apply id');
  const bold = match[1]!;
  const collisions = allIds.filter((id) => id !== allIds[0] && id.startsWith(bold));
  assert.equal(collisions.length, 0, 'the bold prefix uniquely identifies the vacancy across all pages');
});
