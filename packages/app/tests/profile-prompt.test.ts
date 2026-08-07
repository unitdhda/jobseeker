import assert from 'node:assert/strict';
import test from 'node:test';
import { existingUnitsAdvisory } from '../src/workflows.ts';

test('the advisory lists existing search wordings, deduplicated, content only', () => {
  const advisory = existingUnitsAdvisory([
    { name: 'ML', text: 'machine learning engineer' },
    { name: 'ML dup', text: 'machine learning engineer' },
    { query: 'data engineer' },
    { specialization: 'design', facet: 'product' },
  ]);
  assert.match(advisory, /machine learning engineer/u);
  assert.match(advisory, /data engineer/u);
  assert.match(advisory, /design/u);
  assert.equal((advisory.match(/machine learning engineer/gu) ?? []).length, 1, 'deduplicated');
  // Advisory only, and never anything about who runs these searches.
  assert.match(advisory, /advisory/iu);
  assert.doesNotMatch(advisory, /user|subscriber/iu);
});

test('an empty unit population adds nothing to the prompt', () => {
  assert.equal(existingUnitsAdvisory([]), '');
  assert.equal(existingUnitsAdvisory([{ facet: 'all' }]), '', 'queries with no usable wording are nothing');
});

test('the advisory is capped so a large population cannot crowd out the CV', () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ text: `role ${index}` }));
  const advisory = existingUnitsAdvisory(many);
  assert.equal((advisory.match(/role \d+/gu) ?? []).length, 30);
});
