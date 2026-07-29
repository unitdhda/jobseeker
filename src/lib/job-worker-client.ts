import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GeneratedApplication } from './application-artifacts.ts';
import type { ScrapeCycleResult } from './jobs.ts';
import { config } from '../config.ts';
import type {
  JobWorkerMessage, JobWorkerRequest, RefreshUserResult, SerializedApplication,
} from './job-worker-protocol.ts';

type JobPayload =
  | { type: 'run-cycle' }
  | { type: 'refresh-user'; userId: string; cvHash: string }
  | { type: 'tailor-application'; userId: string; vacancyId: number };

let child: ChildProcess | undefined;
let nextId = 1;
let ready: Promise<void> | undefined;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function workerCommand(): { modulePath: string; args: string[] } {
  const built = resolve(process.cwd(), 'dist/worker.mjs');
  if (existsSync(built)) return { modulePath: built, args: [] };
  const tsx = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const source = resolve(process.cwd(), 'src/worker.ts');
  if (existsSync(tsx) && existsSync(source)) return { modulePath: tsx, args: [source] };
  throw new Error('Background worker entry was not found. Run npm run build.');
}

function ensureWorker(): { child: ChildProcess; ready: Promise<void> } {
  if (child?.connected && ready) return { child, ready };
  const command = workerCommand();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise; rejectReady = rejectPromise;
  });
  const spawned = fork(command.modulePath, command.args, {
    env: { ...process.env, RUN_JOBS: 'false', RUN_INITIAL_CYCLE: 'false', TELEGRAM_POLLING: 'false' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child = spawned;
  spawned.on('message', (message: JobWorkerMessage) => {
    if (message.kind === 'ready') { resolveReady(); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error));
  });
  spawned.once('error', (error) => rejectReady(error));
  spawned.once('exit', (code, signal) => {
    const error = new Error(`Background worker exited (${signal ?? code ?? 'unknown'}).`);
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    if (child === spawned) { child = undefined; ready = undefined; }
  });
  return { child: spawned, ready };
}

async function request<T>(payload: JobPayload): Promise<T> {
  if (pending.size >= config.maxPendingWorkerJobs) throw new Error('Background job queue is full; retry later.');
  const id = nextId++;
  const worker = ensureWorker();
  await worker.ready;
  if (pending.size >= config.maxPendingWorkerJobs) throw new Error('Background job queue is full; retry later.');
  return new Promise<T>((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: (value) => resolvePromise(value as T), reject: rejectPromise });
    worker.child.send({ id, ...payload } satisfies JobWorkerRequest, (error) => {
      if (!error) return;
      pending.delete(id);
      rejectPromise(error);
    });
  });
}

export function runCycleInWorker(): Promise<ScrapeCycleResult | null> {
  return request({ type: 'run-cycle' });
}
export function refreshUserInWorker(userId: string, cvHash: string): Promise<RefreshUserResult> {
  return request({ type: 'refresh-user', userId, cvHash });
}
export async function tailorApplicationInWorker(userId: string, vacancyId: number): Promise<GeneratedApplication> {
  const result = await request<SerializedApplication>({ type: 'tailor-application', userId, vacancyId });
  return { tailoredCvPdf: Buffer.from(result.tailoredCvPdfBase64, 'base64'), coverLetter: result.coverLetter };
}
