import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtractedCvDocument } from './cv-adapters.ts';

const parserTimeoutMs = 30_000;
const parserMemoryMb = 256;
const maximumConcurrentParsers = 2;
let activeParsers = 0;
interface CvWorkerResponse { ok: boolean; result?: ExtractedCvDocument; error?: string }

function command(): { modulePath: string; args: string[]; execArgv: string[] } {
  const root = process.cwd();
  const built = resolve(root, 'dist/cv-worker.mjs');
  if (existsSync(built) && /(?:^|\/)dist\//.test(process.argv[1] ?? '')) {
    return { modulePath: built, args: [], execArgv: [
      `--max-old-space-size=${parserMemoryMb}`, '--permission',
      `--allow-fs-read=${resolve(root, 'dist')}`, `--allow-fs-read=${resolve(root, 'node_modules')}`,
    ] };
  }
  const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');
  const source = resolve(root, 'src/cv-worker.ts');
  if (existsSync(tsx) && existsSync(source)) {
    return { modulePath: tsx, args: [source], execArgv: [`--max-old-space-size=${parserMemoryMb}`] };
  }
  throw new Error('Isolated CV parser entry was not found. Run npm run build.');
}

export function extractCvDocumentIsolated(filename: string, mediaType: string | undefined,
  bytes: Uint8Array): Promise<ExtractedCvDocument> {
  const parser = command();
  if (activeParsers >= maximumConcurrentParsers) return Promise.reject(new Error('CV parser is busy; retry later.'));
  activeParsers++;
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = fork(parser.modulePath, parser.args, {
        env: { NODE_ENV: 'production', LANG: process.env.LANG ?? 'C.UTF-8', PATH: process.env.PATH ?? '' },
        execArgv: parser.execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch (error) {
      activeParsers--;
      rejectPromise(error); return;
    }
    let settled = false;
    const settle = (error?: Error, result?: ExtractedCvDocument): void => {
      if (settled) return;
      settled = true; activeParsers--; clearTimeout(timer);
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill('SIGKILL');
      if (error) rejectPromise(error); else resolvePromise(result!);
    };
    const timer = setTimeout(() => settle(new Error('CV parsing exceeded the 30 second limit.')), parserTimeoutMs);
    child.once('error', (error) => settle(error));
    child.once('exit', (code, signal) => {
      if (!settled) settle(new Error(`Isolated CV parser exited (${signal ?? code ?? 'unknown'}).`));
    });
    child.once('message', (message: CvWorkerResponse) => {
      if (message.ok && message.result) settle(undefined, message.result);
      else settle(new Error(message.error || 'CV parser failed.'));
    });
    child.send({ filename, mediaType, bytes: Buffer.from(bytes) }, (error) => { if (error) settle(error); });
  });
}
