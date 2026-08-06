import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { createSourceProvider, createSources, type SourcesOptions } from '../src/index.ts';

function coreOptions(limit: number): SourcesOptions { return {
  limits: { searchNewVacancyLimit: limit, searchPageBudgetPerPlatform: 3 },
  trace: () => undefined, errorMessage: String, recordListingCandidate: async () => true,
}; }

test('open provider registration passes collection runtime through an explicit context', async () => {
  const schema = v.strictObject({ version: v.literal(1), searches: v.array(v.object({ query: v.string() })) });
  let observedLimit = 0;
  const source = createSourceProvider({
    id: 'runtime-test', name: 'Runtime test', hosts: ['runtime.example'], schema,
    template: () => ({ platform: 'runtime-test', version: 1, purpose: 'Test.', jsonShape: {},
      capabilities: {}, rules: [] }),
    discover: async (_plan, context) => {
      observedLimit = context.limits.searchNewVacancyLimit;
      return { searches: 0, users: 0, seen: 0, discovered: 0 };
    },
    normalize: async () => new Map(),
  });
  const sources = createSources(coreOptions(7));
  sources.setProvider(source);
  await sources.getPlatform('runtime-test').discover({ searches: [] });
  assert.equal(observedLimit, 7);
  await sources.close();
});
