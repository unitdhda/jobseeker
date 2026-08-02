import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import { getEncryptedRuntimeState, putEncryptedRuntimeState } from './encrypted-state-store.ts';

const execute = promisify(execFile);
const objectPath = 'browser/hh.tar.gz';
const archiveRoot = 'hh-browser';
const maximumArchiveBytes = 180 * 1024 * 1024;

function cloudStateConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    && process.env.SUPABASE_STORAGE_BUCKET && process.env.RUNTIME_STATE_ENCRYPTION_KEY);
}

export async function restoreHhBrowserState(): Promise<boolean> {
  if (!cloudStateConfigured()) return false;
  const archive = await getEncryptedRuntimeState(objectPath);
  if (!archive) return false;
  if (archive.byteLength > maximumArchiveBytes) throw new Error('Encrypted HH browser-state archive exceeds its limit.');
  const work = await mkdtemp(join(tmpdir(), 'jobseeker-hh-restore-'));
  try {
    const archivePath = join(work, 'state.tar.gz');
    await writeFile(archivePath, archive, { mode: 0o600 });
    const { stdout } = await execute('tar', ['-tzf', archivePath], { maxBuffer: 10 * 1024 * 1024 });
    const entries = stdout.split('\n').filter(Boolean);
    if (!entries.length || entries.some((entry) => entry.startsWith('/') || entry.includes('..')
      || (entry !== archiveRoot && !entry.startsWith(`${archiveRoot}/`)))) {
      throw new Error('HH browser-state archive contains an unsafe path.');
    }
    await execute('tar', ['-xzf', archivePath, '-C', work]);
    const extracted = join(work, archiveRoot);
    await stat(extracted);
    await mkdir(dirname(config.hhBrowserDataPath), { recursive: true, mode: 0o700 });
    await rm(config.hhBrowserDataPath, { recursive: true, force: true });
    await rename(extracted, config.hhBrowserDataPath);
    return true;
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function persistHhBrowserState(): Promise<boolean> {
  if (!cloudStateConfigured()) return false;
  try { await stat(config.hhBrowserDataPath); }
  catch { return false; }
  if (basename(config.hhBrowserDataPath) !== archiveRoot) {
    throw new Error(`HH_BROWSER_DATA_PATH must end with ${archiveRoot} when cloud state is enabled.`);
  }
  const work = await mkdtemp(join(tmpdir(), 'jobseeker-hh-save-'));
  try {
    const archivePath = join(work, 'state.tar.gz');
    await execute('tar', ['-czf', archivePath, '-C', dirname(config.hhBrowserDataPath), archiveRoot]);
    const archive = await readFile(archivePath);
    if (archive.byteLength > maximumArchiveBytes) throw new Error('HH browser-state archive exceeds its encrypted storage limit.');
    await putEncryptedRuntimeState(objectPath, archive);
    return true;
  } finally { await rm(work, { recursive: true, force: true }); }
}
