import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import { AdaptiveTaskPool } from '@jobseeker/engine/concurrency';
import {
  parseCvContentHash,
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  type VacancyContent,
} from '@jobseeker/engine/contracts';
import type { PendingMatch } from '@jobseeker/store';
import type { JsonModels } from '../src/ai.ts';
import {
  prescorePendingVacancies,
  scorePendingVacancies,
  type ScoringWorkflowPorts,
  type WorkflowVacancy,
} from '../src/workflows.ts';

const userId = parseUserId('123');
const source = parseSourceKey('test');
const cvHash = parseCvContentHash('a'.repeat(64));
const usage: Usage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 150,
  cost: { input: .1, output: .1, cacheRead: .01, cacheWrite: .04, total: .25 } };
const primary: Model<Api> = { id: 'primary', name: 'Primary', provider: 'test', api: 'test', baseUrl: 'local:test',
  reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
const fallback: Model<Api> = { ...primary, id: 'fallback', name: 'Fallback' };
function response(model: Model<Api>, value: unknown, stopReason: AssistantMessage['stopReason'] = 'stop', errorMessage?: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], provider: model.provider, model: model.id,
    api: model.api, usage, stopReason, timestamp: 0, ...(errorMessage ? { errorMessage } : {}) };
}
function models(handler: (model: Model<Api>, signal: AbortSignal | undefined, prompt: string) => Promise<AssistantMessage>): JsonModels {
  return { getModel: (_provider, id) => id === primary.id ? primary : id === fallback.id ? fallback : undefined,
    completeSimple: (model, context, options) => handler(model, options?.signal, context.messages[0]?.content as string) };
}
function pending(id: number): PendingMatch {
  return { userId, vacancyId: id, source, publishedAt: new Date(), matchedAt: new Date(), lexicalScore: 50,
    regexScore: 50, lexicalCosine: .5, titleSimilarity: .5, skillCoverage: .5, seniorityGap: null, specificity: null,
    lexicalCosineIdf: null, prescoreScore: null, prescoreModel: null, prescorePromptVersion: null, prescoreExploration: false };
}
function vacancy(id: number): WorkflowVacancy {
  const content: VacancyContent = { source, sourceId: parseSourceVacancyId(String(id)), name: `Backend Engineer ${id}`,
    employer: 'Employer', area: 'Remote', salary: null, experience: { kind: 'unspecified' }, employment: 'full-time',
    schedule: 'standard', workFormat: 'remote', description: 'Build TypeScript APIs.', keySkills: ['TypeScript'],
    url: new URL(`https://example.test/${id}`), publishedAt: new Date(), sourceQuery: 'backend' };
  return { id, ...content };
}
function verdict(id: number, total = 80) {
  return { vacancyId: id, total, dimensions: { skills: 35, seniority: 15, responsibilities: 12, domain: 8,
    locationWorkFormat: 7, compensation: 3 }, requirements: [], blockers: [], primaryTrack: 'Backend engineer',
    summary: 'Strong fit', reasons: ['Role', 'Skills', 'Responsibilities', 'extra'], gaps: ['Domain', 'Compensation', 'extra'],
    hardRejection: false };
}

function ports(ids: readonly number[], overrides: Partial<ScoringWorkflowPorts> = {}) {
  const queued = new Set<number>(); const durable = new Set<number>(); const released: number[] = [];
  const reservations: number[] = []; const prescores: number[] = []; const scores: Array<{ id: number; reasons: readonly string[]; gaps: readonly string[] }> = [];
  const llm: string[] = []; const spend: number[] = [];
  const value: ScoringWorkflowPorts = {
    getCvSource: async () => ({ hash: cvHash, text: 'Experienced backend engineer using TypeScript.' }),
    pendingMatchesForPrescoring: async () => ids.map(pending),
    pendingMatchesForScoring: async () => ids.map(pending),
    claimMatches: async (_user, requested) => { requested.forEach((id) => queued.add(id)); return [...requested]; },
    releaseMatchClaims: async (_user, requested) => { let count = 0; for (const id of requested) if (queued.delete(id)) { released.push(id); count += 1; } return count; },
    getVacancy: async (id) => ids.includes(id) ? vacancy(id) : null,
    savePrescore: async (_user, id) => { prescores.push(id); queued.delete(id); return true; },
    saveScore: async (_user, id, _score, _track, _summary, reasons, gaps) => {
      scores.push({ id, reasons, gaps }); durable.add(id); queued.delete(id); return true;
    },
    savedScoreVacancyIds: async (_user, requested) => requested.filter((id) => durable.has(id)),
    reserveScoreUsage: async (_user, id) => { reservations.push(id); },
    recordLlmUsage: async (_user, agent, modelId) => { llm.push(`${agent}:${modelId}`); },
    addScoreSpend: async (_user, cost) => { spend.push(cost); }, ...overrides,
  };
  return { value, queued, durable, released, reservations, prescores, scores, llm, spend };
}

test('prescoring saves exact results with frozen exploration and releases every failed batch claim', async () => {
  const good = ports([1, 2]); let randomCalls = 0;
  const report = await prescorePendingVacancies({ userId, models: models(async () => response(primary, { results: [
    { vacancyId: 1, score: 39, rationale: 'Below threshold' }, { vacancyId: 2, score: 70, rationale: 'Strong fit' }] })),
    model: 'test/primary', promptVersion: 'v2', threshold: 40, explorationRate: .1, random: () => { randomCalls += 1; return .05; },
    batchSize: 2, cycleCap: 10, ports: good.value });
  assert.deepEqual(report, { selected: 2, claimed: 2, saved: 2, released: 0, failedBatches: 0, errors: [] });
  assert.deepEqual(good.prescores, [1, 2]); assert.equal(randomCalls, 1); assert.equal(good.queued.size, 0);

  const bad = ports([1, 2]);
  const failed = await prescorePendingVacancies({ userId, models: models(async () => response(primary,
    { results: [{ vacancyId: 1, score: 50, rationale: 'Missing second result' }] })), model: 'test/primary',
    promptVersion: 'v2', threshold: 40, explorationRate: .1, batchSize: 2, cycleCap: 10, ports: bad.value,
    errorMessage: () => 'invalid batch' });
  assert.equal(failed.saved, 0); assert.equal(failed.failedBatches, 1); assert.equal(failed.released, 2);
  assert.deepEqual(bad.released.sort(), [1, 2]); assert.deepEqual(bad.prescores, []);
});

test('full scoring saves durable explanation, bounded alert fields, recency context, and per-vacancy usage accounting', async () => {
  const fixture = ports([1, 2]); let scoringPrompt = '';
  const report = await scorePendingVacancies({ userId, models: models(async (_model, _signal, prompt) => {
    scoringPrompt = prompt; return response(primary, { scores: [verdict(1), verdict(2)] });
  }),
    model: 'test/primary', prescorePromptVersion: 'v2', prescoreThreshold: 40, cycleCap: 2, batchSize: 2,
    timeoutMs: 1000, maxAttempts: 1, pool: new AdaptiveTaskPool(1, 2), ports: fixture.value });
  assert.equal(report.saved, 2); assert.equal(report.released, 0); assert.equal(report.failedBatches, 0);
  assert.deepEqual(fixture.reservations, [1, 2]); assert.deepEqual(fixture.llm, ['score:test/primary']);
  assert.deepEqual(fixture.spend, [.125, .125]); assert.ok(fixture.scores.every((item) => item.reasons.length === 3 && item.gaps.length === 2));
  assert.match(scoringPrompt, /"age":"published today"/u); assert.deepEqual([...fixture.durable], [1, 2]);
});

test('terminal subscription limit switches to fallback and retries the whole batch', async () => {
  const fixture = ports([1, 2]); let calls = 0;
  const report = await scorePendingVacancies({ userId, models: models(async (selected) => {
    calls += 1;
    return selected.id === 'primary'
      ? response(primary, {}, 'error', 'subscription usage limit exhausted')
      : response(fallback, { scores: [verdict(1), verdict(2)] });
  }), model: 'test/primary', fallbackModel: 'test/fallback', prescorePromptVersion: 'v2', prescoreThreshold: 40,
    cycleCap: 2, batchSize: 2, timeoutMs: 1000, maxAttempts: 2, pool: new AdaptiveTaskPool(1, 1), ports: fixture.value });
  assert.equal(calls, 2); assert.equal(report.usedFallback, true); assert.equal(report.saved, 2);
  assert.deepEqual(fixture.reservations, [1, 2, 1, 2]);
  assert.deepEqual(fixture.llm, ['score:test/primary', 'score:test/fallback']);
});

test('timeout and partial write failures release only rows without durable scores', async () => {
  const timeoutFixture = ports([1]);
  const timeout = await scorePendingVacancies({ userId, models: models(async (_model, signal) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  })), model: 'test/primary', prescorePromptVersion: 'v2', prescoreThreshold: 40, cycleCap: 1, batchSize: 1,
    timeoutMs: 10, maxAttempts: 1, pool: new AdaptiveTaskPool(1, 1), ports: timeoutFixture.value,
    errorMessage: () => 'timed out' });
  assert.equal(timeout.failedBatches, 1); assert.equal(timeout.released, 1); assert.deepEqual(timeout.errors, ['timed out']);

  const partial = ports([1, 2]); let writes = 0;
  partial.value.saveScore = async (_user, id) => { writes += 1; if (writes === 1) { partial.durable.add(id); partial.queued.delete(id); return true; }
    throw new Error('write failed'); };
  const report = await scorePendingVacancies({ userId, models: models(async () => response(primary, { scores: [verdict(1), verdict(2)] })),
    model: 'test/primary', prescorePromptVersion: 'v2', prescoreThreshold: 40, cycleCap: 2, batchSize: 2,
    timeoutMs: 1000, maxAttempts: 1, pool: new AdaptiveTaskPool(1, 1), ports: partial.value, errorMessage: () => 'write failed' });
  assert.equal(report.saved, 1); assert.equal(report.failedBatches, 1); assert.equal(report.released, 1);
  assert.deepEqual([...partial.durable], [1]); assert.deepEqual(partial.released, [2]);
});
