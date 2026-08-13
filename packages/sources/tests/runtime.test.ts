import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import {
  createSourceProvider,
  createSources,
  type SourceContext,
  type SourcesOptions,
} from '../src/index.ts';
import {
  parseSourceKey,
  parseSourceVacancyId,
  parseVacancyListingHash,
  type VacancyCandidate,
} from '@jobseeker/engine/contracts';

const profileSchema = v.strictObject({
  searches: v.array(v.strictObject({ name: v.string(), text: v.string() })),
});

function options(searchNewVacancyLimit = 10): SourcesOptions {
  return {
    limits: { searchNewVacancyLimit, searchPageBudgetPerPlatform: 5 },
    trace() {},
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    recordListingCandidate: async () => true,
  };
}

function provider(id: string, hooks: {
  discover?: (context: SourceContext) => void;
  normalize?: (context: SourceContext) => void;
  close?: (context: SourceContext) => void | Promise<void>;
} = {}) {
  return createSourceProvider({
    id,
    name: id.toUpperCase(),
    hosts: [`${id}.example.test`, `${id}.example.test`],
    schema: profileSchema,
    template: () => ({ platform: id, version: 1, purpose: 'test', jsonShape: {}, capabilities: {}, rules: [] }),
    async discover(_plan, context) {
      hooks.discover?.(context);
      return { searches: 0, users: 0, seen: 0, discovered: 0 };
    },
    async normalize(_candidates, context) {
      hooks.normalize?.(context);
      return new Map();
    },
    ...(hooks.close ? { close: hooks.close } : {}),
  });
}

function candidate(source: string): VacancyCandidate {
  return {
    source: parseSourceKey(source),
    sourceId: parseSourceVacancyId('vacancy-1'),
    url: new URL(`https://${source}.example.test/jobs/1`),
    searchName: 'private search',
    title: 'Developer',
    summary: '',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    listingHash: parseVacancyListingHash('a'.repeat(64)),
    status: 'queued',
    attempts: 0,
    combinedScore: null,
  };
}

test('collections with the same provider IDs remain independent and bind context only on platform use', async () => {
  const observed: number[] = [];
  const contexts = new Set<SourceContext>();
  const first = createSources(options());
  const second = createSources(options(20));
  first.setProvider(provider('same', { discover: (context) => {
    observed.push(context.limits.searchNewVacancyLimit); contexts.add(context);
  } }));
  second.setProvider(provider('same', { discover: (context) => {
    observed.push(context.limits.searchNewVacancyLimit); contexts.add(context);
  } }));

  assert.deepEqual(observed, []);
  await first.getPlatform('same').discover({ searches: [] });
  await second.getPlatform('same').discover({ searches: [] });
  assert.deepEqual(observed, [10, 20]);
  assert.equal(contexts.size, 2);
});

test('replacement preserves order while deletion and clear do not discard owned URL policy', () => {
  const sources = createSources(options());
  const first = provider('first');
  sources.setProvider(first);
  sources.setProvider(provider('second'));
  sources.setProvider(provider('first'));
  assert.deepEqual(sources.platformIds, ['first', 'second']);
  assert.deepEqual(first.hosts, ['first.example.test']);

  sources.deleteProvider('first');
  assert.equal(sources.getProvider('first'), undefined);
  assert.equal(sources.urlPolicy.safeVacancyUrl('first', 'https://first.example.test/jobs/1'),
    'https://first.example.test/jobs/1');
  sources.clearProviders();
  assert.deepEqual(sources.platformIds, []);
  assert.equal(sources.urlPolicy.safeVacancyUrl('second', 'https://second.example.test/jobs/1'),
    'https://second.example.test/jobs/1');
});

test('profile parsing is strict and provider factory rejects cross-source normalization', async () => {
  const sources = createSources(options());
  const item = provider('alpha');
  sources.setProvider(item);
  assert.deepEqual(sources.platformSearches('alpha', { searches: [{ name: 'Backend', text: 'TypeScript' }] }),
    [{ name: 'Backend', text: 'TypeScript' }]);
  assert.throws(() => sources.platformSearches('alpha', { searches: [], extra: true }), /Invalid alpha search profile/u);
  await assert.rejects(() => item.normalize([candidate('beta')], {} as SourceContext),
    /cannot normalize candidate source beta/u);
});

test('close is idempotent, closes every ever-owned provider once, and rejects later mutation', async () => {
  const closed: string[] = [];
  const sources = createSources(options());
  sources.setProvider(provider('first', { close: () => { closed.push('first-old'); } }));
  sources.setProvider(provider('first', { close: () => { closed.push('first-new'); } }));
  sources.setProvider(provider('second', { close: () => { closed.push('second'); } }));
  sources.deleteProvider('second');
  const one = sources.close();
  const two = sources.close();
  assert.equal(one, two);
  await one;
  assert.deepEqual(closed, ['first-old', 'first-new', 'second']);
  assert.throws(() => sources.setProvider(provider('later')), /closed/u);
  assert.throws(() => sources.deleteProvider('first'), /closed/u);
  assert.throws(() => sources.clearProviders(), /closed/u);
});

test('one close error propagates directly and multiple failures aggregate', async () => {
  const singleError = new Error('single close');
  const single = createSources(options());
  single.setProvider(provider('one', { close: () => { throw singleError; } }));
  await assert.rejects(single.close(), (error) => error === singleError);

  const multiple = createSources(options());
  multiple.setProvider(provider('one', { close: () => { throw new Error('one'); } }));
  multiple.setProvider(provider('two', { close: () => { throw new Error('two'); } }));
  await assert.rejects(multiple.close(), (error) => error instanceof AggregateError && error.errors.length === 2);
});
