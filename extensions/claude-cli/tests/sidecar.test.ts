import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClaudeSidecar, sidecarArgs, validBearer } from '../sidecar.ts';

async function executable(root: string): Promise<string> {
  const path = join(root, 'claude');
  await writeFile(path, `#!/usr/bin/env node
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'echo:'+prompt}}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'echo:'+prompt,oauth:{accessToken:'rotated',expiresAt:9999}}));});`);
  await chmod(path, 0o755); return path;
}

async function serverFixture(root: string, overrides: Partial<Parameters<typeof createClaudeSidecar>[0]> = {}) {
  const server = createClaudeSidecar({ host: '127.0.0.1', port: 0, token: '0123456789abcdef',
    executablePath: await executable(root), timeoutMs: 5000, maxBodyBytes: 10000, maxConcurrency: 1, ...overrides });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}
const request = { model: 'claude-sonnet-4-6', systemPrompt: 'sys', prompt: 'hello', effort: 'high' };
const auth = { authorization: 'Bearer 0123456789abcdef', 'content-type': 'application/json' };

test('bearer comparison and bind policy reject invalid credentials/public listeners', () => {
  assert.equal(validBearer('Bearer 0123456789abcdef', '0123456789abcdef'), true);
  assert.equal(validBearer('Bearer wrong', '0123456789abcdef'), false);
  assert.throws(() => createClaudeSidecar({ host: '8.8.8.8', port: 1, token: '0123456789abcdef', executablePath: 'x',
    timeoutMs: 1, maxBodyBytes: 1, maxConcurrency: 1 }), /private/u);
});

test('sidecar allowlist builds fixed CLI arguments and refuses arbitrary request fields', async () => {
  const args = sidecarArgs({ ...request, jsonSchema: { type: 'object' } });
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  const root = await mkdtemp(join(tmpdir(), 'claude-sidecar-'));
  try {
    const { server, url } = await serverFixture(root);
    try {
      const forbidden = await fetch(`${url}/v1/stream`, { method: 'POST', headers: auth,
        body: JSON.stringify({ ...request, args: ['--dangerously-skip-permissions'] }) });
      assert.equal(forbidden.status, 400); assert.match(await forbidden.text(), /forbidden/u);
      const unauthorized = await fetch(`${url}/v1/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      assert.equal(unauthorized.status, 401);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sidecar streams NDJSON and atomically persists rotated OAuth without leaking it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-sidecar-oauth-')); const oauthFile = join(root, 'oauth.json');
  await writeFile(oauthFile, JSON.stringify({ accessToken: 'initial', expiresAt: 1000 }));
  try {
    const { server, url } = await serverFixture(root, { oauthFile });
    try {
      const health = await (await fetch(`${url}/health`)).json() as Record<string, unknown>;
      assert.deepEqual(health, { ok: true, auth: 'oauth-file', expiresAt: 1000 });
      assert.equal(JSON.stringify(health).includes('initial'), false);
      const response = await fetch(`${url}/v1/stream`, { method: 'POST', headers: auth, body: JSON.stringify(request) });
      assert.equal(response.status, 200); const text = await response.text();
      assert.match(text, /echo:hello/u); assert.equal(text.includes('accessToken'), false); assert.equal(text.includes('rotated'), false);
      assert.deepEqual(JSON.parse(await readFile(oauthFile, 'utf8')), { accessToken: 'rotated', expiresAt: 9999 });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sidecar enforces content type and body bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-sidecar-limits-'));
  try {
    const { server, url } = await serverFixture(root, { maxBodyBytes: 20 });
    try {
      const wrong = await fetch(`${url}/v1/stream`, { method: 'POST', headers: { authorization: auth.authorization }, body: '{}' });
      assert.equal(wrong.status, 415);
      const large = await fetch(`${url}/v1/stream`, { method: 'POST', headers: auth, body: JSON.stringify(request) });
      assert.equal(large.status, 413);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
