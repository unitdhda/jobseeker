import assert from 'node:assert/strict';
import test from 'node:test';
import { VacancySearchCollector } from '../src/index.ts';
import {
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  type VacancyCandidateInput,
} from '@jobseeker/engine/contracts';

function listing(source: string, sourceId: string, searchName: string): VacancyCandidateInput {
  return {
    source: parseSourceKey(source), sourceId: parseSourceVacancyId(sourceId),
    url: new URL(`https://${source}.example.test/${sourceId}`), searchName, title: `Vacancy ${sourceId}`,
  };
}

const recipients = [
  { userId: parseUserId('1'), searchName: 'Backend' },
  { userId: parseUserId('2'), searchName: 'Backend' },
  { userId: parseUserId('3'), searchName: 'TypeScript' },
];

test('collector writes each shared identity once and counts recipient search names without duplicating users', async () => {
  const writes: VacancyCandidateInput[] = [];
  const collector = new VacancySearchCollector(3, async (input) => { writes.push(input); return true; });
  assert.equal(await collector.record(listing('one', 'a:b', 'internal-one'), recipients), true);
  assert.equal(await collector.record(listing('one', 'a:b', 'internal-two'), recipients), false);
  // Length-prefixing prevents delimiter-shaped source IDs from colliding.
  assert.equal(await collector.record(listing('one', 'b', 'internal-three'), recipients), true);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((item) => item.searchName), ['internal-one', 'internal-three']);
  assert.deepEqual(collector.result(), {
    seen: 2, discovered: 2, discoveredBySearch: { Backend: 2, TypeScript: 2 },
  });
});

test('collector counts seen old listings but only new writes consume the global limit', async () => {
  const writes: string[] = [];
  const collector = new VacancySearchCollector(2, async (input) => {
    writes.push(input.sourceId);
    return input.sourceId !== 'old';
  });
  assert.equal(await collector.record(listing('one', 'old', 'old query'), recipients), false);
  assert.equal(await collector.record(listing('one', 'new-1', 'one'), recipients), true);
  assert.equal(await collector.record(listing('one', 'new-2', 'two'), recipients), true);
  assert.equal(collector.complete, true);
  assert.equal(await collector.record(listing('one', 'never-written', 'three'), recipients), false);
  assert.deepEqual(writes, ['old', 'new-1', 'new-2']);
  assert.deepEqual(collector.result(), {
    seen: 3, discovered: 2, discoveredBySearch: { Backend: 2, TypeScript: 2 },
  });
});
