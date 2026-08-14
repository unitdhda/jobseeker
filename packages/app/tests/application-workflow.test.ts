import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import type { CanonicalCvDocument } from '@jobseeker/cv/extract';
import { parseCvContentHash, parseSourceKey, parseSourceVacancyId, parseUserId } from '@jobseeker/engine/contracts';
import type { JsonModels } from '../src/ai.ts';
import { tailorApplication, tailorCvSystemPrompt, coverLetterSystemPrompt, type ApplicationPorts } from '../src/application.ts';

const userId = parseUserId('123'); const hash = parseCvContentHash('a'.repeat(64));
const changedHash = parseCvContentHash('b'.repeat(64)); const source = parseSourceKey('test');
const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: .01, output: .01, cacheRead: 0, cacheWrite: 0, total: .02 } };
const model: Model<Api> = { id: 'model', name: 'Model', provider: 'test', api: 'test', baseUrl: 'local:test', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
const canonical: CanonicalCvDocument = { version: 1, blocks: [{ type: 'heading', text: 'Jane Doe', level: 1 },
  { type: 'paragraph', text: 'Backend Engineer at Acme from 2020 to 2024. Built TypeScript APIs.', source: { start: 0, end: 75 } }] };
const cvText = `Jane Doe\nBackend Engineer\nAcme\n2020–2024\nBuilt TypeScript APIs and PostgreSQL services.\nEmail jane@example.com.\n${'Reliable delivery. '.repeat(8)}`;
const vacancy = { id: 7, source, sourceId: parseSourceVacancyId('7'), name: 'Backend Engineer', employer: 'Target', area: 'Remote',
  salary: null, experience: { kind: 'range' as const, minimumYears: 3, maximumYears: null }, employment: 'full-time' as const,
  schedule: 'standard' as const, workFormat: 'remote' as const, description: 'Build TypeScript APIs.', keySkills: ['TypeScript'],
  url: new URL('https://example.test/7'), publishedAt: new Date(), sourceQuery: 'backend' };
function ai(value: unknown, calls: string[] = []): JsonModels {
  return { getModel: () => model, completeSimple: async (_model, context) => { calls.push(context.systemPrompt ?? '');
    return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], provider: model.provider, model: model.id,
      api: model.api, usage, stopReason: 'stop', timestamp: 0 } satisfies AssistantMessage; } };
}
function fixture(overrides: Partial<ApplicationPorts> = {}) {
  const events: string[] = [];
  const ports: ApplicationPorts = {
    getCvSource: async () => ({ hash, text: cvText, document: canonical }), getCvHash: async () => hash,
    getVacancy: async () => vacancy, deliveredArtifact: async () => null,
    reserveApplicationUsage: async (_user, artifact) => { events.push(`reserve:${artifact}`); },
    beginApplication: async (_user, _id, artifact, cvHash) => { events.push(`begin:${artifact}:${cvHash}`); return true; },
    markApplicationReady: async () => { events.push('ready'); return true; },
    failApplication: async (_user, _id, error) => { events.push(`fail:${error}`); return true; },
    recordLlmUsage: async (_user, agent, qualified) => { events.push(`llm:${agent}:${qualified}`); }, ...overrides,
  };
  return { ports, events };
}

const tailoredDocument = { name: 'Jane Doe', headline: 'Backend Engineer', contacts: ['jane@example.com'], sections: [{
  title: 'Experience', blocks: [{ kind: 'entry', title: 'Acme', subtitle: 'Backend Engineer', meta: '2020–2024',
    bullets: ['Built TypeScript APIs and PostgreSQL services.'] }],
}] };

test('matching CV-hash cache returns before reservation, state transition, model, or rendering', async () => {
  const value = fixture({ deliveredArtifact: async () => ({ cvSha256: hash, fileId: 'telegram-file', deliveredAt: new Date() }) });
  let modelCalls = 0; let renderCalls = 0;
  const result = await tailorApplication({ userId, vacancyId: 7, artifact: 'cv', models: ai(tailoredDocument), model: 'test/model',
    ports: value.ports, renderer: { render: () => { renderCalls += 1; return new Uint8Array([1]); } } });
  modelCalls += 0;
  assert.equal(result.kind, 'cached'); assert.equal(result.artifact, 'cv'); assert.deepEqual(value.events, []);
  assert.equal(modelCalls, 0); assert.equal(renderCalls, 0);
});

test('tailored CV uses independent prompt, evidence gate, renderer, and ready transition without persisting bytes', async () => {
  assert.match(tailorCvSystemPrompt, /"artifact":"cv".*"document"/su);
  for (const kind of ['text', 'bullets', 'entry', 'facts']) assert.match(tailorCvSystemPrompt, new RegExp(`"kind":"${kind}"`, 'u'));
  assert.match(tailorCvSystemPrompt, /Keep every employer/u); assert.match(tailorCvSystemPrompt, /never hide a gap/iu);
  const value = fixture(); const prompts: string[] = []; let rendered = 0;
  const result = await tailorApplication({ userId, vacancyId: 7, artifact: 'cv',
    models: ai({ artifact: 'cv', document: tailoredDocument }, prompts), model: 'test/model', ports: value.ports,
    renderer: { render: (document) => { rendered += 1; assert.equal(document.name, 'Jane Doe'); return new Uint8Array([37, 80, 68, 70]); } } });
  assert.equal(result.kind, 'generated'); assert.equal(result.artifact, 'cv');
  if (result.kind === 'generated' && result.artifact === 'cv') assert.deepEqual([...result.pdf], [37, 80, 68, 70]);
  assert.equal(rendered, 1); assert.equal(prompts[0], tailorCvSystemPrompt);
  assert.deepEqual(value.events, [`reserve:cv`, `begin:cv:${hash}`, 'llm:tailor-application:test/model', 'ready']);
});

test('cover letter is a separate model call, schema, usage agent, and plain-text result', async () => {
  assert.match(coverLetterSystemPrompt, /"artifact":"letter","text"/u);
  assert.match(coverLetterSystemPrompt, /specific evidence over generic enthusiasm/u);
  const value = fixture(); const prompts: string[] = [];
  const letter = 'I built TypeScript APIs and PostgreSQL services at Acme, directly matching this backend role.\n\nI would bring that concrete delivery experience to the team.';
  const result = await tailorApplication({ userId, vacancyId: 7, artifact: 'letter',
    models: ai({ artifact: 'letter', text: letter }, prompts), model: 'test/model', ports: value.ports });
  assert.deepEqual(result, { kind: 'generated', artifact: 'letter', cvHash: hash, text: letter });
  assert.equal(prompts[0], coverLetterSystemPrompt);
  assert.deepEqual(value.events, [`reserve:letter`, `begin:letter:${hash}`, 'llm:tailor-cover-letter:test/model', 'ready']);
});

test('unsupported evidence or stale CV persists bounded failure and returns no artifact', async () => {
  const invented = fixture();
  await assert.rejects(tailorApplication({ userId, vacancyId: 7, artifact: 'cv', models: ai({ artifact: 'cv', document: {
    ...tailoredDocument, sections: [{ title: 'Experience', blocks: [{ kind: 'entry', title: 'Invented Corp', meta: '2025', text: 'Grew revenue 900%.' }] }],
  } }), model: 'test/model', ports: invented.ports, renderer: { render: () => new Uint8Array([1]) }, errorMessage: () => 'evidence rejected' }),
  /unsupported evidence/u);
  assert.equal(invented.events.at(-1), 'fail:evidence rejected'); assert.equal(invented.events.includes('ready'), false);

  const stale = fixture({ getCvHash: async () => changedHash });
  await assert.rejects(tailorApplication({ userId, vacancyId: 7, artifact: 'letter', models: ai({ artifact: 'letter',
    text: 'I built TypeScript APIs and PostgreSQL services at Acme for several years, providing concrete evidence for this backend role.' }),
    model: 'test/model', ports: stale.ports, errorMessage: () => 'stale cv' }), /changed during/u);
  assert.equal(stale.events.at(-1), 'fail:stale cv');
});
