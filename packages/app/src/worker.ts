import { pathToFileURL } from 'node:url';
import { KeyedTaskScheduler } from '@jobseeker/engine/concurrency';
import { parseCvContentHash, type CvContentHash, type UserId } from '@jobseeker/engine/contracts';
import type { GeneratedApplication } from './application.ts';
import type { ProfileRefreshResult } from './profile-refresh.ts';
import { parseJobWorkerRequest, type JobPayload, type JobWorkerMessage, type SerializedJobResult } from './worker-protocol.ts';

export interface JobWorkerHandlers {
  getCvHash(userId: UserId): Promise<CvContentHash | null>;
  refreshUser(userId: UserId, cvHash: CvContentHash): Promise<ProfileRefreshResult>;
  tailorApplication(userId: UserId, vacancyId: number, artifact: 'cv' | 'letter'): Promise<GeneratedApplication>;
  close?(): Promise<void>;
}
export interface JobWorkerTransport {
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  send(message: JobWorkerMessage): void;
  disconnect(): void;
}
export interface JobWorkerServer { readonly pendingCount: number; close(): void }

function serializeRefresh(result: ProfileRefreshResult): SerializedJobResult {
  return Object.freeze({ type: 'refresh-user', cvHash: result.cvHash, generatedPlatforms: result.generatedPlatforms,
    failedPlatforms: result.failedPlatforms });
}
function serializeApplication(result: GeneratedApplication): SerializedJobResult {
  if (result.kind === 'cached') {
    if (result.artifact === 'cv') {
      if (!result.cached.fileId) throw new TypeError('Cached CV has no Telegram file ID.');
      return Object.freeze({ type: 'tailor-application', artifact: 'cv', kind: 'cached',
        cvHash: parseCvContentHash(result.cached.cvSha256), fileId: result.cached.fileId });
    }
    if (!result.cached.text) throw new TypeError('Cached letter has no text.');
    return Object.freeze({ type: 'tailor-application', artifact: 'letter', kind: 'cached',
      cvHash: parseCvContentHash(result.cached.cvSha256), text: result.cached.text });
  }
  if (result.artifact === 'letter') return Object.freeze({ type: 'tailor-application', artifact: 'letter', kind: 'generated',
    cvHash: result.cvHash, text: result.text });
  return Object.freeze({ type: 'tailor-application', artifact: 'cv', kind: 'generated', cvHash: result.cvHash,
    pdfBase64: Buffer.from(result.pdf).toString('base64') });
}

export function createJobWorkerServer(transport: JobWorkerTransport, handlers: JobWorkerHandlers,
  options: { readonly concurrency: number; readonly maxPending: number }): JobWorkerServer {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1
    || !Number.isSafeInteger(options.maxPending) || options.maxPending < 1) throw new RangeError('Invalid job worker bounds.');
  const scheduler = new KeyedTaskScheduler<UserId>(options.concurrency); const activeIds = new Set<number>();
  let accepted = 0; let closed = false;
  const run = async (payload: JobPayload): Promise<SerializedJobResult> => {
    if (payload.type === 'refresh-user') {
      // Hash validation belongs inside the per-user serialization window so an earlier queued CV job cannot stale it.
      if (await handlers.getCvHash(payload.userId) !== payload.cvHash) throw new Error('Refresh job CV hash is stale.');
      return serializeRefresh(await handlers.refreshUser(payload.userId, payload.cvHash));
    }
    return serializeApplication(await handlers.tailorApplication(payload.userId, payload.vacancyId, payload.artifact));
  };
  transport.onMessage((raw) => {
    if (closed) return;
    let request;
    try { request = parseJobWorkerRequest(raw); }
    catch (error) {
      const id = typeof (raw as { id?: unknown })?.id === 'number' && Number.isSafeInteger((raw as { id: number }).id)
        && (raw as { id: number }).id > 0 ? (raw as { id: number }).id : null;
      if (id === null) { closed = true; transport.disconnect(); return; }
      transport.send({ kind: 'result', id, ok: false,
        error: error instanceof Error ? error.message.slice(0, 1_000) : 'Invalid job request.' }); return;
    }
    if (activeIds.has(request.id)) { transport.send({ kind: 'result', id: request.id, ok: false, error: 'Duplicate active job request ID.' }); return; }
    if (accepted >= options.maxPending) {
      transport.send({ kind: 'result', id: request.id, ok: false, error: 'Job worker pending queue is full.' }); return;
    }
    accepted += 1; activeIds.add(request.id);
    void scheduler.run(request.payload.userId, () => run(request.payload)).then(
      (result) => transport.send({ kind: 'result', id: request.id, ok: true, result }),
      (error: unknown) => transport.send({ kind: 'result', id: request.id, ok: false,
        error: (error instanceof Error ? error.message : 'Job failed.').slice(0, 1_000) }),
    ).finally(() => { accepted -= 1; activeIds.delete(request.id); });
  });
  transport.onDisconnect(() => { closed = true; void handlers.close?.().catch(() => undefined); });
  transport.send({ kind: 'ready' });
  return Object.freeze({ get pendingCount(): number { return accepted; }, close(): void { closed = true; transport.disconnect(); } });
}

function processTransport(): JobWorkerTransport {
  if (!process.send) throw new Error('Job worker requires an IPC channel.');
  const send = process.send.bind(process);
  return {
    onMessage: (listener) => { process.on('message', listener); },
    onDisconnect: (listener) => { process.once('disconnect', listener); },
    send: (message) => { send(message); },
    disconnect: () => { if (process.connected) process.disconnect?.(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const imported = await import('./worker-runtime.ts') as { readonly default?: JobWorkerHandlers };
  if (!imported.default) throw new Error('Bundled worker runtime did not provide handlers.');
  createJobWorkerServer(processTransport(), imported.default, {
    concurrency: Number(process.env.USER_WORKFLOW_CONCURRENCY ?? 5),
    maxPending: Number(process.env.MAX_PENDING_WORKER_JOBS ?? 100),
  });
}
