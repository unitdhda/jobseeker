import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import { parseCvContentHash, parseSourceKey, parseUserId } from '@jobseeker/engine/contracts';
import type { ProfileRefreshPorts } from '../src/profile-refresh.ts';
import { refreshUserProfiles, StaleCvError } from '../src/profile-refresh.ts';
import type { JsonModels } from '../src/ai.ts';

const hash = parseCvContentHash('a'.repeat(64)); const otherHash = parseCvContentHash('b'.repeat(64));
const userId = parseUserId('123');
const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: .01 } };
const model: Model<Api> = { id: 'model', name: 'Model', provider: 'test', api: 'test', baseUrl: 'local:test', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
function answer(value: unknown): AssistantMessage { return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }],
  provider: model.provider, model: model.id, api: model.api, usage, stopReason: 'stop', timestamp: 0 }; }
function models(values: readonly unknown[], prompts: string[] = []): JsonModels {
  let index = 0; return { getModel: () => model, completeSimple: async (_model, context) => {
    prompts.push(context.messages[0]!.content); return answer(values[index++]); } };
}
const profileSchema = v.strictObject({ version: v.literal(1), searches: v.pipe(v.array(v.strictObject({
  name: v.pipe(v.string(), v.minLength(1)), query: v.pipe(v.string(), v.minLength(1)),
})), v.maxLength(2)) });
const provider = (id: string) => ({ id, schema: profileSchema, template: () => ({ platform: id, version: 1,
  purpose: `Search ${id}`, jsonShape: { version: 1, searches: [{ name: 'Track', query: 'Role' }] },
  capabilities: { maxSearches: 2 }, rules: ['Return at most 2 searches.'] }) });

function ports(overrides: Partial<ProfileRefreshPorts> = {}) {
  const savedCareer: unknown[] = []; const savedSearches: Array<{ platform: string; value: unknown }> = [];
  const reserved: string[] = []; const llm: string[] = []; const applied: unknown[] = []; const hooks: string[] = [];
  const value: ProfileRefreshPorts = {
    getCvSource: async () => ({ hash, text: 'Authoritative backend engineering CV evidence.' }),
    getCvHash: async () => hash,
    saveCareerProfile: async (_user, profile) => { savedCareer.push(profile); },
    getSearchProfile: async () => null,
    saveSearchProfile: async (_user, platform, profile) => { savedSearches.push({ platform, value: profile }); },
    activeUnitQueries: async () => [{ query: 'old wording' }], existingCompiledUnits: async () => [],
    applyDemand: async (_user, demand) => { applied.push(demand); },
    reserveProfileUsage: async (_user, agent) => { reserved.push(agent); },
    recordLlmUsage: async (_user, agent, qualified) => { llm.push(`${agent}:${qualified}`); },
    refreshRoleEquivalences: async () => { hooks.push('equivalence'); },
    backfillRecentStock: async () => { hooks.push('backfill'); }, ...overrides,
  };
  return { value, savedCareer, savedSearches, reserved, llm, applied, hooks };
}
const career = { version: 1, tracks: [{ name: 'Backend engineer', titleVariants: ['Backend Engineer'],
  coreSkills: ['TypeScript'], evidence: ['Built APIs'] }] };

test('profile refresh binds generated profiles to CV, reserves before calls, compiles demand, then runs maintenance', async () => {
  const fixture = ports(); const prompts: string[] = [];
  const result = await refreshUserProfiles({ userId, providers: [provider('one'), provider('two')],
    models: models([career, { version: 1, searches: [{ name: 'Backend', query: 'Backend Engineer' }] },
      { version: 1, searches: [] }], prompts), model: 'test/model', clusterSimilarity: .6, initialCadenceMinutes: 30,
    ports: fixture.value });
  assert.deepEqual(result.generatedPlatforms, ['one', 'two']); assert.deepEqual(result.failedPlatforms, {});
  assert.equal(fixture.savedCareer.length, 1); assert.equal(fixture.savedSearches.length, 2);
  assert.deepEqual(fixture.reserved, ['career-profile', 'search-profile:one', 'search-profile:two']);
  assert.deepEqual(fixture.llm, ['career-profile:test/model', 'search-profile:one:test/model', 'search-profile:two:test/model']);
  assert.equal(result.demand.units.length, 1); assert.equal(result.demand.subscriptions[0]?.searchName, 'Backend');
  assert.deepEqual(fixture.hooks, ['equivalence', 'backfill']); assert.equal(fixture.applied.length, 1);
  assert.match(prompts[1]!, /old wording/u);
});

test('one provider failure is isolated and a fresh persisted profile may still contribute demand', async () => {
  const persisted = { cvHash: hash, templateVersion: 1,
    profile: { version: 1, searches: [{ name: 'Persisted', query: 'Persisted Engineer' }] } };
  const fixture = ports({ getSearchProfile: async (_user, platform) => platform === parseSourceKey('bad') ? persisted : null });
  const result = await refreshUserProfiles({ userId, providers: [provider('good'), provider('bad')],
    models: models([career, { version: 1, searches: [{ name: 'Good', query: 'Good Engineer' }] },
      { wrong: true }, { wrong: true }, { wrong: true }]), model: 'test/model', clusterSimilarity: 1, initialCadenceMinutes: 30,
    ports: fixture.value, errorMessage: () => 'isolated' });
  assert.deepEqual(result.generatedPlatforms, ['good']); assert.deepEqual(result.failedPlatforms, { bad: 'isolated' });
  assert.equal(result.demand.units.length, 2);
});

test('CV hash change aborts before persisting career or compiling mixed demand', async () => {
  const fixture = ports({ getCvHash: async () => otherHash });
  await assert.rejects(refreshUserProfiles({ userId, providers: [provider('one')], models: models([career]),
    model: 'test/model', clusterSimilarity: .6, initialCadenceMinutes: 30, ports: fixture.value }), StaleCvError);
  assert.equal(fixture.savedCareer.length, 0); assert.equal(fixture.savedSearches.length, 0);
  assert.equal(fixture.applied.length, 0); assert.deepEqual(fixture.hooks, []);
});
