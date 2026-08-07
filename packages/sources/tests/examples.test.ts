import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleSources } from '../examples/index.ts';

test('example source factories return fresh providers with unique ids and closed host lists', () => {
  const first = exampleSources({ maxPages: 1 });
  const second = exampleSources({ maxPages: 1 });
  const ids = first.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length, 'provider ids are unique');
  assert.ok(ids.includes('habr') && ids.includes('sber') && ids.includes('ats'));
  assert.ok(!ids.includes('hh'), 'browser-backed sources are extensions, not examples');
  for (let index = 0; index < first.length; index++) {
    assert.notEqual(first[index], second[index], `${ids[index]} factory returns fresh instances`);
    assert.ok(first[index]!.hosts.length > 0, `${ids[index]} declares its hosts`);
  }
});
