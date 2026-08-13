import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export interface RuntimeStateStore {
  configured(): boolean;
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, plaintext: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

export const hhStateObjectPath = 'browser/hh.tar.gz';
export const maximumHhArchiveBytes = 180 * 1024 * 1024;
const excluded = ['Cache', 'Code Cache', 'GPUCache', 'Crashpad', 'Crash Reports', 'BrowserMetrics', 'GrShaderCache', 'DawnCache'];

function runTar(args: readonly string[], cwd?: string): Promise<{ readonly stdout: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('/usr/bin/tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('exit', (code) => code === 0 ? resolveRun({ stdout })
      : rejectRun(new Error(`HH browser-state archive command failed with code ${code}: ${stderr.slice(0, 300)}`)));
  });
}

export function assertSafeHhArchiveEntries(entries: readonly string[]): void {
  if (entries.length === 0) throw new TypeError('Invalid HH browser archive: archive is empty.');
  for (const raw of entries) {
    const entry = raw.replace(/\/$/u, '');
    const parts = entry.split('/');
    if (!entry || isAbsolute(entry) || parts.some((part) => part === '..' || part === '') || parts[0] !== 'hh-browser') {
      throw new TypeError('Invalid HH browser archive path.');
    }
  }
}

async function boundedFile(path: string): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximumHhArchiveBytes) throw new RangeError('HH browser archive exceeds 180 MiB.');
  return new Uint8Array(await readFile(path));
}

export async function persistHhBrowserState(state: RuntimeStateStore, browserDataPath: string): Promise<boolean> {
  if (!state.configured()) return false;
  const source = resolve(browserDataPath);
  if (basename(source) !== 'hh-browser') throw new TypeError('HH browser state path must end in hh-browser.');
  const workspace = await mkdtemp(join(tmpdir(), 'jobseeker-hh-state-'));
  const archive = join(workspace, 'hh.tar.gz');
  try {
    const args = ['-czf', archive, ...excluded.flatMap((name) => ['--exclude', `hh-browser/**/${name}`, '--exclude', `hh-browser/${name}`]),
      '-C', dirname(source), 'hh-browser'];
    await runTar(args);
    await state.put(hhStateObjectPath, await boundedFile(archive));
    return true;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function restoreHhBrowserState(state: RuntimeStateStore, browserDataPath: string): Promise<boolean> {
  if (!state.configured()) return false;
  const bytes = await state.get(hhStateObjectPath);
  if (!bytes) return false;
  if (bytes.byteLength > maximumHhArchiveBytes) throw new RangeError('HH browser archive exceeds 180 MiB.');
  const destination = resolve(browserDataPath);
  if (basename(destination) !== 'hh-browser') throw new TypeError('HH browser state path must end in hh-browser.');
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, '.hh-restore-'));
  const archive = join(workspace, 'hh.tar.gz'); const extraction = join(workspace, 'extract');
  try {
    await writeFile(archive, bytes); await mkdir(extraction);
    const listed = (await runTar(['-tzf', archive])).stdout.split(/\r?\n/u).filter(Boolean);
    assertSafeHhArchiveEntries(listed);
    await runTar(['-xzf', archive, '-C', extraction, '--no-same-owner', '--no-same-permissions']);
    const staged = join(extraction, 'hh-browser');
    // The destination and staging directory share a parent filesystem, so rename is atomic at cutover.
    const old = join(parent, `.hh-browser-old-${Date.now()}`);
    let hadOld = false;
    try { await rename(destination, old); hadOld = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { await rename(staged, destination); } catch (error) {
      if (hadOld) await rename(old, destination).catch(() => {});
      throw error;
    }
    if (hadOld) await rm(old, { recursive: true, force: true });
    return true;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
