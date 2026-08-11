/**
 * App-side CV handling. Mechanical extraction lives in @jobseeker/cv/extract; this file keeps what is coupled to the
 * deployment: the sandboxed parser subprocess (it knows the dist/ layout) and the database import path.
 */
export {
  canonicalDocumentText, detectCvLanguage, extractCvDocument, extractText, getDocumentProxy, maximumCvBytes,
  type CanonicalCvDocument, type CvDocumentBlock, type CvLanguage, type CvSourceFormat, type ExtractedCvDocument,
} from '@jobseeker/cv/extract';
import type { ExtractedCvDocument } from '@jobseeker/cv/extract';

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const parserTimeoutMs = 30_000;
const parserMemoryMb = 256;
const maximumConcurrentParsers = 2;
let activeParsers = 0;
interface CvWorkerResponse { ok: boolean; result?: ExtractedCvDocument; error?: string }

/** The worker entry lives next to this module in both layouts: dist/ when built, the package src/ otherwise. */
function command(): { modulePath: string; args: string[]; execArgv: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'cv-worker.mjs');
  if (existsSync(built)) {
    return { modulePath: built, args: [], execArgv: [
      `--max-old-space-size=${parserMemoryMb}`, '--permission',
      `--allow-fs-read=${here}`, `--allow-fs-read=${resolve(process.cwd(), 'node_modules')}`,
    ] };
  }
  const source = join(here, 'cv-worker.ts');
  if (process.versions.bun && existsSync(source)) {
    return { modulePath: source, args: [], execArgv: ['--no-env-file', `--max-old-space-size=${parserMemoryMb}`] };
  }
  throw new Error('Isolated CV parser entry was not found. Run bun run build.');
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

import { createHash } from 'node:crypto';
import { clearSearchProfile, confirmStagedCvSource, requireApprovedUser, stageCvSource } from './postgres.ts';
import { searchPlatformIds } from './vacancies/registry.ts';
import { careerProfilePlatformId } from '@jobseeker/engine';

export interface CvImportPreview { filename:string; characters:number; blocks:number; excerpt:string;
  warnings:NonNullable<ExtractedCvDocument['document']['warnings']> }
export async function importCvSource(userId: string, filename: string,
  mediaType: string | undefined, bytes: Uint8Array): Promise<CvImportPreview> {
  const extracted = await extractCvDocumentIsolated(filename, mediaType, bytes);
  await requireApprovedUser(userId);
  const hash = createHash('sha256').update(bytes).digest('hex');
  await stageCvSource(userId,filename,hash,extracted);
  return {filename,characters:extracted.text.length,blocks:extracted.document.blocks.length,
    excerpt:extracted.text.slice(0,700),warnings:extracted.document.warnings??[]};
}
export async function confirmCvImport(userId:string):Promise<boolean>{
  await requireApprovedUser(userId);
  if(!await confirmStagedCvSource(userId))return false;
  for(const platformId of [...searchPlatformIds,careerProfilePlatformId])await clearSearchProfile(userId,platformId);
  return true;
}
