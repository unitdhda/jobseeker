import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertSafeHhArchiveEntries,
  hhStateObjectPath,
  persistHhBrowserState,
  restoreHhBrowserState,
  type RuntimeStateStore,
} from '../state.ts';

function memoryState(configured = true): RuntimeStateStore & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return { values, configured: () => configured, get: async (path) => values.get(path) ?? null,
    put: async (path, value) => { values.set(path, value); }, delete: async (path) => { values.delete(path); } };
}

test('archive path validation permits only descendants of hh-browser', () => {
  assert.doesNotThrow(() => assertSafeHhArchiveEntries(['hh-browser/', 'hh-browser/Default/', 'hh-browser/Default/Cookies']));
  for (const entries of [[], ['/etc/passwd'], ['../outside'], ['hh-browser/../outside'], ['other/file'], ['hh-browser//file']]) {
    assert.throws(() => assertSafeHhArchiveEntries(entries), /archive/u);
  }
});

test('browser state persists only hh-browser, excludes caches, and restores atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hh-state-test-'));
  try {
    const source = join(root, 'hh-browser');
    await mkdir(join(source, 'Default', 'Cache'), { recursive: true });
    await writeFile(join(source, 'Default', 'Cookies'), 'cookie-data');
    await writeFile(join(source, 'Default', 'Cache', 'cache.bin'), 'discard-me');
    const state = memoryState();
    assert.equal(await persistHhBrowserState(state, source), true);
    assert.ok(state.values.get(hhStateObjectPath)?.byteLength);

    await rm(source, { recursive: true }); await mkdir(source); await writeFile(join(source, 'old'), 'old-data');
    assert.equal(await restoreHhBrowserState(state, source), true);
    assert.equal(await readFile(join(source, 'Default', 'Cookies'), 'utf8'), 'cookie-data');
    await assert.rejects(() => readFile(join(source, 'Default', 'Cache', 'cache.bin')), /ENOENT/u);
    await assert.rejects(() => readFile(join(source, 'old')), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unconfigured or absent encrypted state is a no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hh-state-noop-'));
  try {
    assert.equal(await persistHhBrowserState(memoryState(false), join(root, 'hh-browser')), false);
    assert.equal(await restoreHhBrowserState(memoryState(), join(root, 'hh-browser')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
