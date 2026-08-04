import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GeneratedApplication } from './documents.ts';
import type { ScrapeCycleResult } from './vacancies/jobs.ts';
import { config } from './config.ts';

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
  throw new Error('Background worker entry was not found. Run bun run build.');
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
    env: { ...process.env, RUN_JOBS: 'false', RUN_INITIAL_CYCLE: 'false', TELEGRAM_MODE: 'off', TELEGRAM_POLLING: 'false' },
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

export function jobWorkerStatus():{active:number;pending:number;capacity:number}{
  return {active:child?.connected?1:0,pending:pending.size,capacity:config.maxPendingWorkerJobs};
}

export async function stopJobWorker():Promise<void>{
  const running=child;if(!running)return;
  child=undefined;ready=undefined;
  if(running.connected)running.disconnect();
  await Promise.race([new Promise<void>(resolve=>running.once('exit',()=>resolve())),
    new Promise<void>(resolve=>setTimeout(()=>{running.kill('SIGKILL');resolve();},3_000))]);
}

export function runCycleInWorker(): Promise<ScrapeCycleResult | null> {
  return request({ type: 'run-cycle' });
}
export function refreshUserInWorker(userId: string, cvHash: string): Promise<RefreshUserResult> {
  return request({ type: 'refresh-user', userId, cvHash });
}
export async function tailorApplicationInWorker(userId: string, vacancyId: number): Promise<GeneratedApplication> {
  const result = await request<SerializedApplication>({ type: 'tailor-application', userId, vacancyId });
  return { tailoredCvPdf: result.tailoredCvPdfBase64 ? Buffer.from(result.tailoredCvPdfBase64, 'base64') : null,
    coverLetter: result.coverLetter };
}

export type JobWorkerRequest =
  | { id: number; type: 'run-cycle' }
  | { id: number; type: 'refresh-user'; userId: string; cvHash: string }
  | { id: number; type: 'tailor-application'; userId: string; vacancyId: number };

export interface RefreshUserResult {
  searchCount: number;
  platformCount: number;
  cycle: ScrapeCycleResult | null;
}
export interface SerializedApplication extends Omit<GeneratedApplication, 'tailoredCvPdf'> {
  tailoredCvPdfBase64: string | null;
}

export type JobWorkerSuccess = { kind: 'result'; id: number; ok: true; result: unknown };
export type JobWorkerFailure = { kind: 'result'; id: number; ok: false; error: string };
export type JobWorkerMessage = { kind: 'ready' } | JobWorkerSuccess | JobWorkerFailure;
