/**
 * Persists the HH browser profile across hosts through the application's encrypted blob store. Without a
 * configured store both calls are no-ops and the profile simply lives on the local volume.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

export interface RuntimeStateStore {
  configured(): boolean;
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, plaintext: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

const execute = promisify(execFile);
const objectPath = 'browser/hh.tar.gz';
const archiveRoot = 'hh-browser';
const maximumArchiveBytes = 180 * 1024 * 1024;

export async function restoreHhBrowserState(state: RuntimeStateStore, browserDataPath: string): Promise<boolean> {
  if (!state.configured()) return false;
  const archive = await state.get(objectPath);
  if (!archive) return false;
  if (archive.byteLength > maximumArchiveBytes) throw new Error('Encrypted HH browser-state archive exceeds its limit.');
  // Staged beside the target rather than in the system temp dir: the final step is a rename, and when /tmp is a
  // separate mount (tmpfs in a container) a cross-device rename fails with EXDEV.
  const parent = dirname(browserDataPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(parent, '.hh-restore-'));
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
    await rm(browserDataPath, { recursive: true, force: true });
    await rename(extracted, browserDataPath);
    return true;
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function persistHhBrowserState(state: RuntimeStateStore, browserDataPath: string): Promise<boolean> {
  if (!state.configured()) return false;
  try { await stat(browserDataPath); }
  catch { return false; }
  if (basename(browserDataPath) !== archiveRoot) {
    throw new Error(`HH_BROWSER_DATA_PATH must end with ${archiveRoot} when cloud state is enabled.`);
  }
  const work = await mkdtemp(join(tmpdir(), 'jobseeker-hh-save-'));
  try {
    const archivePath = join(work, 'state.tar.gz');
    await execute('tar', ['-czf', archivePath,
      '--exclude=*/Cache','--exclude=*/Code Cache','--exclude=*/GPUCache','--exclude=*/DawnCache',
      '--exclude=*/GrShaderCache','--exclude=*/ShaderCache','--exclude=*/Crashpad','--exclude=*/BrowserMetrics',
      '-C', dirname(browserDataPath), archiveRoot]);
    const archive = await readFile(archivePath);
    if (archive.byteLength > maximumArchiveBytes) throw new Error('HH browser-state archive exceeds its encrypted storage limit.');
    await state.put(objectPath, archive);
    return true;
  } finally { await rm(work, { recursive: true, force: true }); }
}
