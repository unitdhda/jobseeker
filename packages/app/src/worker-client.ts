import { fork, type ChildProcess } from 'node:child_process';
import type { JobPayload, JobResult, JobWorkerMessage } from './worker-protocol.ts';
import { deserializeJobResult, parseJobPayload } from './worker-protocol.ts';

export interface JobWorkerCommand {
  readonly modulePath: string;
  readonly args?: readonly string[];
  readonly execArgv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
export interface JobWorkerClientOptions {
  readonly command: JobWorkerCommand;
  readonly maxPending: number;
  readonly readyTimeoutMs?: number;
  readonly spawn?: (command: JobWorkerCommand) => ChildProcess;
}
export interface JobWorkerClient {
  readonly ready: Promise<void>;
  readonly pendingCount: number;
  request(payload: JobPayload): Promise<JobResult>;
  close(): Promise<void>;
}

interface Pending { resolve(value: JobResult): void; reject(error: Error): void }
function defaultSpawn(command: JobWorkerCommand): ChildProcess {
  return fork(command.modulePath, [...(command.args ?? [])], { execArgv: [...(command.execArgv ?? [])],
    env: { ...process.env, ...(command.env ?? {}), TELEGRAM_MODE: 'off', TELEGRAM_POLLING: 'false', RUN_JOBS: 'false' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

export function createJobWorkerClient(options: JobWorkerClientOptions): JobWorkerClient {
  if (!Number.isSafeInteger(options.maxPending) || options.maxPending < 1) throw new RangeError('Invalid worker maximum pending queue.');
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) throw new RangeError('Invalid worker ready timeout.');
  const child = (options.spawn ?? defaultSpawn)(options.command);
  const pending = new Map<number, Pending>(); let nextId = 1; let ready = false; let closed = false; let closePromise: Promise<void> | undefined;
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => fail(new Error('Job worker did not become ready in time.')), readyTimeoutMs);
  function fail(error: Error): void {
    if (closed) return;
    closed = true; clearTimeout(readyTimer); if (!ready) rejectReady(error);
    for (const item of pending.values()) item.reject(error); pending.clear();
  }
  child.on('message', (raw: unknown) => {
    const message = raw as Partial<JobWorkerMessage>;
    if (message.kind === 'ready') { if (!ready && !closed) { ready = true; clearTimeout(readyTimer); resolveReady(); } return; }
    if (message.kind !== 'result' || !Number.isSafeInteger(message.id)) { fail(new Error('Job worker sent an invalid IPC message.')); return; }
    const item = pending.get(message.id!); if (!item) { fail(new Error('Job worker replied with an unknown request ID.')); return; }
    pending.delete(message.id!);
    if (message.ok === true && message.result) {
      try { item.resolve(deserializeJobResult(message.result)); } catch (error) { item.reject(error instanceof Error ? error : new Error('Invalid worker result.')); }
    } else {
      const failure = message as Record<string, unknown>;
      item.reject(new Error(typeof failure.error === 'string' ? failure.error.slice(0, 1_000) : 'Job worker failed.'));
    }
  });
  child.once('error', (error) => fail(new Error('Job worker process failed.', { cause: error })));
  child.once('exit', (code, signal) => fail(new Error(`Job worker exited${code !== null ? ` with code ${code}` : ` on ${signal}`}.`)));
  child.once('disconnect', () => { if (!closed) fail(new Error('Job worker disconnected.')); });

  return Object.freeze({
    get ready(): Promise<void> { return readyPromise; },
    get pendingCount(): number { return pending.size; },
    async request(payload: JobPayload): Promise<JobResult> {
      const validated = parseJobPayload(payload);
      await readyPromise;
      if (closed || !child.connected) throw new Error('Job worker is not available.');
      if (pending.size >= options.maxPending) throw new Error('Job worker pending queue is full.');
      if (nextId > Number.MAX_SAFE_INTEGER) throw new Error('Job worker request ID space is exhausted.');
      const id = nextId++; return new Promise<JobResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ kind: 'request', id, payload: validated }, (error) => {
          if (!error) return; const item = pending.get(id); pending.delete(id); item?.reject(new Error('Job worker IPC send failed.', { cause: error }));
        });
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const error = new Error('Job worker is shutting down.'); fail(error);
        if (!child.connected && child.exitCode !== null) return;
        child.disconnect();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); resolve(); }, 3_000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      })();
      return closePromise;
    },
  });
}
