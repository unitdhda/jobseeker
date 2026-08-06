import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import type { VacancyCandidate } from '@jobseeker/engine/contracts';
import { createSourceProvider, createSources } from '../src/index.ts';

const schema = v.strictObject({
  version: v.literal(1),
  searches: v.array(v.strictObject({ query: v.string() })),
});

function provider(id: string, closed: string[]) {
  return createSourceProvider({
    id,
    name: `Source ${id}`,
    hosts: [`${id}.example`],
    schema,
    template: () => ({
      platform: id,
      version: 1,
      purpose: 'Test source.',
      jsonShape: { version: 1, searches: [{ query: 'role' }] },
      capabilities: {},
      rules: [],
    }),
    discover: async (plan) => ({ searches: plan.searches.length, users: 0, seen: 0, discovered: 0 }),
    normalize: async () => new Map(),
    close: () => { closed.push(id); },
  });
}

test('source collections support open provider registration and replacement', () => {
  const closed: string[] = [];
  const sources = createSources();
  const first = provider('first', closed);
  const second = provider('second', closed);
  const replacement = provider('first', closed);

  assert.deepEqual(sources.getProviders(), []);
  assert.equal(sources.getProvider('missing'), undefined);
  sources.setProvider(first);
  sources.setProvider(second);
  sources.setProvider(replacement);

  assert.deepEqual(sources.platformIds, ['first', 'second']);
  assert.equal(sources.getProvider('first'), replacement);
  assert.equal(sources.getProvider('second'), second);
  assert.equal(sources.getPlatform('second').id, second.id);
  assert.throws(() => sources.getPlatform('missing'), /Unknown search platform: missing/);
  assert.deepEqual(sources.platformSearches('first', { version: 1, searches: [{ query: 'designer' }] }),
    [{ query: 'designer' }]);
  assert.throws(() => sources.platformSearches('first', { version: 2, searches: [] }), /profile is invalid/);
});

test('deleted and replaced providers remain collection-owned for idempotent shutdown', async () => {
  const closed: string[] = [];
  const sources = createSources();
  sources.setProvider(provider('first', closed));
  sources.setProvider(provider('first', closed));
  sources.setProvider(provider('second', closed));
  sources.deleteProvider('second');

  assert.deepEqual(sources.platformIds, ['first']);
  await sources.close();
  await sources.close();
  assert.deepEqual(closed, ['first', 'first', 'second']);
  assert.throws(() => sources.setProvider(provider('late', closed)), /collection has closed/);
});

test('source provider factories snapshot declared hosts', () => {
  const closed: string[] = [];
  const hosts = ['jobs.example'];
  const source = createSourceProvider({ ...provider('snapshot', closed), hosts });
  hosts.push('unexpected.example');
  assert.deepEqual(source.hosts, ['jobs.example']);
  assert.ok(Object.isFrozen(source.hosts));
});

test('collections with the same provider id keep independent URL policies', () => {
  const closed: string[] = [];
  const first = createSources(), second = createSources();
  first.setProvider(createSourceProvider({ ...provider('shared', closed), hosts: ['first.example'] }));
  second.setProvider(createSourceProvider({ ...provider('shared', closed), hosts: ['second.example'] }));

  assert.equal(first.urlPolicy.sourceUrl('shared', 'https://first.example/jobs').hostname, 'first.example');
  assert.throws(() => first.urlPolicy.sourceUrl('shared', 'https://second.example/jobs'), /Unexpected/);
  assert.equal(second.urlPolicy.sourceUrl('shared', 'https://second.example/jobs').hostname, 'second.example');
  assert.throws(() => second.urlPolicy.sourceUrl('shared', 'https://first.example/jobs'), /Unexpected/);
});

test('providers reject candidates routed under another source before normalization', async () => {
  const closed: string[] = [];
  let called = false;
  const source = createSourceProvider({ ...provider('expected', closed),
    normalize: async () => { called = true; return new Map(); } });
  const sources = createSources();
  sources.setProvider(source);
  await assert.rejects(() => sources.normalize('expected', [
    { source: 'other', sourceId: '42' } as VacancyCandidate,
  ]), /cannot normalize candidate source other/);
  assert.equal(called, false);
});
