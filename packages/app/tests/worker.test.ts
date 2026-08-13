import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { parseCvContentHash, parseUserId } from '@jobseeker/engine/contracts';
import { createJobWorkerClient } from '../src/worker-client.ts';
import { createJobWorkerServer, type JobWorkerHandlers, type JobWorkerTransport } from '../src/worker.ts';
import { deserializeJobResult, parseJobPayload, parseJobWorkerRequest, type JobWorkerMessage } from '../src/worker-protocol.ts';

const hash = parseCvContentHash('a'.repeat(64)); const otherHash = parseCvContentHash('b'.repeat(64));
const userOne = parseUserId('1'); const userTwo = parseUserId('2');

class MemoryTransport implements JobWorkerTransport {
  messages: JobWorkerMessage[] = []; disconnected = false;
  private messageListener: (message: unknown) => void = () => undefined;
  private disconnectListener: () => void = () => undefined;
  onMessage(listener: (message: unknown) => void): void { this.messageListener = listener; }
  onDisconnect(listener: () => void): void { this.disconnectListener = listener; }
  send(message: JobWorkerMessage): void { this.messages.push(message); }
  disconnect(): void { this.disconnected = true; this.disconnectListener(); }
  receive(message: unknown): void { this.messageListener(message); }
}
const wait = (milliseconds = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('worker protocol strictly validates payloads and canonical PDF base64', () => {
  assert.deepEqual(parseJobPayload({ type: 'refresh-user', userId: '1', cvHash: hash }),
    { type: 'refresh-user', userId: userOne, cvHash: hash });
  assert.throws(() => parseJobPayload({ type: 'refresh-user', userId: '1', cvHash: hash, extra: true }), /fields/u);
  assert.throws(() => parseJobWorkerRequest({ kind: 'request', id: 0, payload: {} }), /request ID/u);
  assert.throws(() => deserializeJobResult({ type: 'tailor-application', artifact: 'cv', kind: 'generated', cvHash: hash,
    pdfBase64: 'not base64!' }), /generated CV/u);
  const result = deserializeJobResult({ type: 'tailor-application', artifact: 'cv', kind: 'generated', cvHash: hash,
    pdfBase64: Buffer.from([1, 2, 3]).toString('base64') });
  assert.deepEqual(result.type === 'tailor-application' && result.artifact === 'cv' ? [...(result.pdf ?? [])] : [], [1, 2, 3]);
});

test('server serializes each user, allows bounded distinct users, checks stale hashes inside scheduler, and base64-serializes PDF', async () => {
  const transport = new MemoryTransport(); let active = 0; let maximum = 0; const order: string[] = [];
  const handlers: JobWorkerHandlers = {
    getCvHash: async (userId) => userId === userOne ? hash : otherHash,
    refreshUser: async (userId) => { active += 1; maximum = Math.max(maximum, active); order.push(`start:${userId}`);
      await wait(10); order.push(`end:${userId}`); active -= 1;
      return { cvHash: userId === userOne ? hash : otherHash, career: { version: 1, tracks: [] }, generatedPlatforms: [],
        failedPlatforms: {}, demand: { units: [], subscriptions: [] } }; },
    tailorApplication: async (_user, _id, artifact) => artifact === 'cv'
      ? { kind: 'generated', artifact: 'cv', cvHash: hash, pdf: new Uint8Array([37, 80]), document: { name: 'N', contacts: [], sections: [] } }
      : { kind: 'generated', artifact: 'letter', cvHash: hash, text: 'x'.repeat(80) },
  };
  const server = createJobWorkerServer(transport, handlers, { concurrency: 2, maxPending: 4 });
  assert.deepEqual(transport.messages.shift(), { kind: 'ready' });
  transport.receive({ kind: 'request', id: 1, payload: { type: 'refresh-user', userId: '1', cvHash: hash } });
  transport.receive({ kind: 'request', id: 2, payload: { type: 'refresh-user', userId: '1', cvHash: hash } });
  transport.receive({ kind: 'request', id: 3, payload: { type: 'refresh-user', userId: '2', cvHash: otherHash } });
  transport.receive({ kind: 'request', id: 4, payload: { type: 'tailor-application', userId: '1', vacancyId: 7, artifact: 'cv' } });
  await wait(40);
  assert.equal(maximum, 2); assert.ok(order.indexOf('end:1') < order.lastIndexOf('start:1'));
  const pdf = transport.messages.find((message) => message.kind === 'result' && message.id === 4);
  assert.equal(pdf?.kind === 'result' && pdf.ok ? pdf.result.type === 'tailor-application' && pdf.result.artifact === 'cv'
    ? pdf.result.pdfBase64 : undefined : undefined, Buffer.from([37, 80]).toString('base64'));
  assert.equal(server.pendingCount, 0);

  transport.receive({ kind: 'request', id: 5, payload: { type: 'refresh-user', userId: '2', cvHash: hash } });
  await wait(); const stale = transport.messages.find((message) => message.kind === 'result' && message.id === 5);
  assert.match(stale?.kind === 'result' && !stale.ok ? stale.error : '', /stale/u);
});

test('server enforces pending bound and rejects duplicate active request IDs', async () => {
  const transport = new MemoryTransport(); let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const handlers: JobWorkerHandlers = { getCvHash: async () => hash,
    refreshUser: async () => { await blocker; return { cvHash: hash, career: { version: 1, tracks: [] }, generatedPlatforms: [],
      failedPlatforms: {}, demand: { units: [], subscriptions: [] } }; },
    tailorApplication: async () => { throw new Error('unused'); } };
  createJobWorkerServer(transport, handlers, { concurrency: 1, maxPending: 1 }); transport.messages.length = 0;
  const request = { kind: 'request', id: 1, payload: { type: 'refresh-user', userId: '1', cvHash: hash } };
  transport.receive(request); transport.receive(request);
  transport.receive({ ...request, id: 2 });
  assert.match((transport.messages[0] as Extract<JobWorkerMessage, { kind: 'result'; ok: false }>).error, /Duplicate/u);
  assert.match((transport.messages[1] as Extract<JobWorkerMessage, { kind: 'result'; ok: false }>).error, /queue is full/u);
  release(); await wait();
});

class FakeChild extends EventEmitter {
  connected = true; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; sent: unknown[] = []; killed?: NodeJS.Signals;
  send(message: unknown, callback?: (error: Error | null) => void): boolean { this.sent.push(message); callback?.(null); return true; }
  disconnect(): void { this.connected = false; this.emit('disconnect'); }
  kill(signal?: NodeJS.Signals | number): boolean { this.killed = signal as NodeJS.Signals; this.signalCode = this.killed; this.emit('exit', null, this.killed); return true; }
}

test('client waits for ready, bounds pending map, decodes results, and rejects all requests on exit', async () => {
  const child = new FakeChild();
  const client = createJobWorkerClient({ command: { modulePath: 'unused' }, maxPending: 1, spawn: () => child as unknown as ChildProcess });
  let settled = false; const beforeReady = client.request({ type: 'tailor-application', userId: userOne, vacancyId: 7, artifact: 'letter' })
    .then(() => { settled = true; });
  await wait(); assert.equal(settled, false); child.emit('message', { kind: 'ready' }); await client.ready; await wait();
  assert.equal(child.sent.length, 1); const id = (child.sent[0] as { id: number }).id;
  await assert.rejects(client.request({ type: 'tailor-application', userId: userOne, vacancyId: 8, artifact: 'letter' }), /queue is full/u);
  child.emit('message', { kind: 'result', id, ok: true, result: { type: 'tailor-application', artifact: 'letter', kind: 'generated', cvHash: hash, text: 'letter' } });
  await beforeReady; assert.equal(settled, true); assert.equal(client.pendingCount, 0);

  const pending = client.request({ type: 'tailor-application', userId: userOne, vacancyId: 9, artifact: 'letter' }); await wait();
  child.exitCode = 1; child.emit('exit', 1, null); await assert.rejects(pending, /exited with code 1/u);
  await assert.rejects(client.request({ type: 'tailor-application', userId: userOne, vacancyId: 10, artifact: 'letter' }), /not available|exited/u);
});
