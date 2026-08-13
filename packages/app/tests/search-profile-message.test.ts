import assert from 'node:assert/strict';
import test from 'node:test';
import { profileSearchTerms, searchProfileMessage } from '../src/telegram/profile-message.ts';

test('profile terms extract bounded recognizable search wording and ignore rationales/private debris', () => {
  const terms = profileSearchTerms({ version: 1, searches: [
    { name: 'Backend', query: 'Backend Engineer', rationale: 'private CV rationale' },
    { name: 'backend', query: 'backend engineer', extra: { title: '<Platform Engineer>' } },
  ] });
  assert.deepEqual(terms, ['Backend', 'Backend Engineer', '<Platform Engineer>']);
  assert.equal(terms.includes('private CV rationale'), false);
});

test('search profile message includes every configured source, empty profiles, and escaped terms', () => {
  const output = searchProfileMessage({ one: { searches: [{ name: 'Track', query: '<Backend & API>' }] } }, ['one', 'two'], 'en').join('\n');
  assert.match(output, /<b>one<\/b>/u); assert.match(output, /&lt;Backend &amp; API&gt;/u);
  assert.match(output, /<b>two<\/b>/u); assert.match(output, /no searches/u);
});
