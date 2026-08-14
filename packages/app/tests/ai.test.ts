import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import type { Api, AssistantMessage, Model, Provider, Usage } from '@earendil-works/pi-ai';
import {
  composeAiModels,
  describeValidationIssues,
  extractJson,
  generateJson,
  llmUsageSince,
  llmUsageSnapshot,
  resolveModel,
  type JsonModels,
} from '../src/ai.ts';

const usage = (cost = 0.25): Usage => ({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 15,
  cost: { input: .1, output: .1, cacheRead: .02, cacheWrite: .03, total: cost } });
const model: Model<Api> = { id: 'model', name: 'Model', api: 'test-api', provider: 'test', baseUrl: 'https://example.test',
  reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000 };
function response(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    usage: usage(), stopReason, timestamp: 0, ...(stopReason === 'error' ? { errorMessage: 'secret upstream detail' } : {}) };
}
function queuedModels(responses: readonly AssistantMessage[], prompts: string[] = []): JsonModels {
  let index = 0;
  return {
    getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    completeSimple: async (_model, context) => { prompts.push(context.messages[0]!.content); return responses[index++]!; },
  };
}
const schema = v.strictObject({ name: v.pipe(v.string(), v.minLength(2)), count: v.pipe(v.number(), v.integer()) });

test('JSON extraction accepts raw, fenced, and balanced embedded values without evaluation', () => {
  assert.deepEqual(extractJson('{"name":"ok"}'), { name: 'ok' });
  assert.deepEqual(extractJson('```json\n[1,2]\n```'), [1, 2]);
  assert.deepEqual(extractJson('Explanation {"text":"brace } in string","nested":[1]} trailing'),
    { text: 'brace } in string', nested: [1] });
  assert.throws(() => extractJson('const x = process.exit()'), /valid JSON/u);
});

test('validation descriptions are bounded, path-specific, and omit rejected values', () => {
  const parsed = v.safeParse(schema, { name: 'x', count: 'TOP_SECRET' });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const description = describeValidationIssues(parsed.issues);
    assert.match(description, /name:/u); assert.match(description, /count:/u);
    assert.equal(description.includes('TOP_SECRET'), false); assert.ok(description.length <= 1_500);
  }
});

test('model resolution fails at role invocation rather than configuration parsing', () => {
  const models = queuedModels([]);
  assert.throws(() => resolveModel(models, undefined, 'Scoring'), /not configured/u);
  assert.throws(() => resolveModel(models, 'missing/model', 'Scoring'), /not registered/u);
  assert.equal(resolveModel(models, 'test/model', 'Scoring'), model);
});

test('JSON generation records each response, feeds bounded validation errors back, and succeeds within three attempts', async () => {
  const prompts: string[] = []; const durable: string[] = []; const before = llmUsageSnapshot();
  const result = await generateJson({ models: queuedModels([
    response('not json'), response('{"name":"x","count":"wrong"}'), response('{"name":"valid","count":2}'),
  ], prompts), model: 'test/model', role: 'Profile', agent: 'profile-test', systemPrompt: 'system', userPrompt: 'user', schema,
  reasoning: 'high', recordUsage: (agent, qualified) => { durable.push(`${agent}:${qualified}`); } });
  assert.deepEqual(result, { name: 'valid', count: 2 }); assert.equal(prompts.length, 3);
  assert.match(prompts[0]!, /Return only the requested complete JSON value/u);
  assert.match(prompts[1]!, /not valid JSON/u); assert.match(prompts[2]!, /name:|count:/u);
  assert.deepEqual(durable, ['profile-test:test/model', 'profile-test:test/model', 'profile-test:test/model']);
  const delta = llmUsageSince(before); assert.equal(delta.turns, 3); assert.equal(delta.totalTokens, 45); assert.ok(Math.abs(delta.costUsd - .75) < 1e-12);
  assert.equal(delta.byAgent['profile-test']?.turns, 3); assert.equal(delta.byModel['test/model']?.turns, 3);
});

test('deterministic repair runs only after model retries and error responses are rejected after accounting', async () => {
  let repairs = 0;
  const repaired = await generateJson({ models: queuedModels([response('{"name":"x","count":1}')]), model: 'test/model',
    role: 'Profile', agent: 'repair-test', systemPrompt: 's', userPrompt: 'u', schema, attempts: 1,
    repair: (value) => { repairs += 1; return { ...(value as object), name: 'repaired' }; } });
  assert.deepEqual(repaired, { name: 'repaired', count: 1 }); assert.equal(repairs, 1);
  const before = llmUsageSnapshot();
  await assert.rejects(generateJson({ models: queuedModels([response('{}', 'error')]), model: 'test/model', role: 'Score',
    agent: 'error-test', systemPrompt: 's', userPrompt: 'u', schema }), /response error/u);
  assert.equal(llmUsageSince(before).turns, 1);
});

test('catalogue composition rejects built-in/extension duplicate provider IDs', () => {
  const provider: Provider = {
    id: 'duplicate', name: 'Duplicate', auth: { apiKey: { name: 'none', resolve: async () => ({ auth: {} }) } },
    getModels: () => [], stream: () => { throw new Error('unused'); }, streamSimple: () => { throw new Error('unused'); },
  };
  assert.throws(() => composeAiModels([provider], { builtins: [provider], env: {} }), /Duplicate AI provider/u);
  const composed = composeAiModels([provider], { builtins: [], env: {} });
  assert.equal(composed.getProvider('duplicate'), provider);
});
