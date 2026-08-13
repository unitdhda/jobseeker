import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

function runNode(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
    child.once('error', reject); child.once('exit', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('launcher supports both env-file forms and preserves existing process values', async () => {
  const root = resolve(import.meta.dirname, '..'); const dist = join(root, 'dist');
  const temporary = await mkdtemp(join(tmpdir(), 'jobseeker-launcher-'));
  const first = join(temporary, 'first.env'); const second = join(temporary, 'second.env');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'cli.js'), `export async function main(argv) { console.log(JSON.stringify({ argv, existing: process.env.EXISTING, quoted: process.env.QUOTED, single: process.env.SINGLE })); return 7; }\n`);
  await writeFile(first, `# ignored\nEXISTING=from-file\nQUOTED="line\\nvalue"\n`);
  await writeFile(second, `export SINGLE='literal # value'\n`);
  try {
    const result = await runNode([join(root, 'bin/jobseeker.mjs'), '--env-file', first, `--env-file=${second}`, 'doctor'],
      { PATH: process.env.PATH, EXISTING: 'from-process' });
    assert.equal(result.code, 7); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { argv: ['doctor'], existing: 'from-process', quoted: 'line\nvalue', single: 'literal # value' });
  } finally { await rm(dist, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }); }
});

test('launcher rejects malformed env files without printing loaded secret values', async () => {
  const root = resolve(import.meta.dirname, '..'); const temporary = await mkdtemp(join(tmpdir(), 'jobseeker-launcher-bad-'));
  const path = join(temporary, 'bad.env'); await writeFile(path, 'TOKEN=TOP_SECRET\nnot valid\n');
  try {
    const result = await runNode([join(root, 'bin/jobseeker.mjs'), '--env-file', path, 'help'], { PATH: process.env.PATH });
    assert.equal(result.code, 1); assert.match(result.stderr, /Invalid environment line/u); assert.doesNotMatch(result.stderr, /TOP_SECRET/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
