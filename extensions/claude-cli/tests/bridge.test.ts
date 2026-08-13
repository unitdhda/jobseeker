import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildArgs,
  claudeCliProvider,
  flattenPrompt,
  sidecarRequest,
  toStopReason,
  toUsage,
} from '../claude-bridge.ts';
import type { Context, Message, Model } from '@earendil-works/pi-ai';

const model: Model<string> = { id: 'claude-sonnet-4-6', name: 'Claude', api: 'claude-cli', provider: 'claude-cli',
  baseUrl: 'local:claude-cli', reasoning: true, input: ['text'], cost: { input: 1e-6, output: 2e-6, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000, maxTokens: 10000 };
const context = (): Context => ({ systemPrompt: 'Replace system', messages: [{ role: 'user', content: 'hello', timestamp: 0 }] });

test('prompt flattening preserves single turns and labels multi-turn text while rejecting images/tools', () => {
  assert.equal(flattenPrompt(context().messages), 'hello');
  const messages: Message[] = [
    { role: 'user', content: 'first', timestamp: 0 },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }], api: 'claude-cli', provider: 'claude-cli',
      model: 'x', usage: toUsage(undefined, 0, model.cost), stopReason: 'stop', timestamp: 0 },
    { role: 'user', content: 'second', timestamp: 0 },
  ];
  assert.equal(flattenPrompt(messages), 'User:\nfirst\n\nAssistant:\nreply\n\nUser:\nsecond');
  assert.throws(() => flattenPrompt([{ role: 'user', content: [{ type: 'image', data: '', mimeType: 'x' }], timestamp: 0 }]), /image/u);
});

test('argument construction replaces system prompt, disables tools, maps effort, and carries optional schema', () => {
  const schema = { type: 'object' };
  const args = buildArgs(model, context(), { reasoning: 'minimal', metadata: { jsonSchema: schema } });
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'Replace system');
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(sidecarRequest(model, context(), { reasoning: 'high' }), {
    model: model.id, systemPrompt: 'Replace system', prompt: 'hello', effort: 'high',
  });
});

test('usage preserves token classes and authoritative CLI cost', () => {
  const usage = toUsage({ input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, 0.5, model.cost);
  assert.deepEqual({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens },
    { input: 100, output: 200, cacheRead: 30, cacheWrite: 40, total: 300 });
  assert.equal(usage.cost.total, 0.5);
  assert.ok(Math.abs(usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite - 0.5) < 1e-9);
  assert.equal(toStopReason('max_tokens', false), 'length'); assert.equal(toStopReason('tool_use', false), 'toolUse');
});

async function fakeCli(root: string): Promise<string> {
  const path = join(root, 'claude');
  await writeFile(path, `#!/usr/bin/env node
const args=process.argv.slice(2); let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>prompt+=c);
process.stdin.on('end',()=>{ const model=args[args.indexOf('--model')+1]; if(model==='fail'){console.error('failed');process.exit(3);return;}
if(model==='missing'){console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'partial'}}}));return;}
console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'thinking_delta',thinking:'thought'}}}));
console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'echo:'+prompt}}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',result:'echo:'+prompt,total_cost_usd:.25,
usage:{input_tokens:11,output_tokens:22,cache_read_input_tokens:3,cache_creation_input_tokens:4}})); });`);
  await chmod(path, 0o755); return path;
}

test('local provider streams thinking/text and handles nonzero or missing-result processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-bridge-'));
  try {
    const executablePath = await fakeCli(root); const provider = claudeCliProvider({ executablePath, defaultTimeoutMs: 5000 });
    const good = provider.getModels()[0]!; const events = [];
    const goodStream = provider.streamSimple(good, context());
    for await (const event of goodStream) events.push(event);
    const final = await goodStream.result();
    assert.equal(final.content.find((item) => item.type === 'text')?.text, 'echo:hello'); assert.equal(final.usage.cost.total, .25);
    assert.ok(events.some((event) => event.type === 'thinking_delta')); assert.ok(events.some((event) => event.type === 'text_delta'));
    const failed = await provider.streamSimple({ ...good, id: 'fail' }, context()).result();
    assert.equal(failed.stopReason, 'error'); assert.match(failed.errorMessage ?? '', /code 3/u);
    const missing = await provider.streamSimple({ ...good, id: 'missing' }, context()).result();
    assert.equal(missing.stopReason, 'error'); assert.match(missing.errorMessage ?? '', /without a result/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote provider sends typed request and parses NDJSON without arbitrary args', async () => {
  let body: unknown; let authorization = '';
  const ndjson = [
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'remote' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'remote', usage: { input_tokens: 1, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const provider = claudeCliProvider({ endpoint: 'http://127.0.0.1:1', endpointToken: 'secret',
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(ndjson, { headers: { 'content-type': 'application/x-ndjson' } }); } });
  const result = await provider.streamSimple(provider.getModels()[0]!, context()).result();
  assert.equal(result.stopReason, 'stop'); assert.equal(authorization, 'Bearer secret');
  assert.deepEqual(Object.keys(body as object).sort(), ['model', 'prompt', 'systemPrompt']);
});
