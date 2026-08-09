import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The examples are the only code here that has to run somewhere else: copied into a deployment's extensions
 * directory, loaded by Node, with no workspace package in sight. Typecheck, the rest of the suite, and the build
 * all read them from inside this repository, where `@jobseeker/*` resolves through node_modules symlinks — so a
 * value import of a package that is never published passes every one of those and still kills the deployment at
 * startup. `import { type X } from '…'` is the easy way to write one by accident: verbatimModuleSyntax drops the
 * specifiers and keeps the module import, which Node's type stripping then tries to resolve.
 *
 * This reproduces the deployment instead of describing it. Three details carry the whole test:
 *   - the copy lives outside the repository, because inside it the workspace symlinks resolve and this passes
 *     while production burns;
 *   - it runs under Node, because Bun erases such an import anyway and would report a false success;
 *   - only valibot is installed, because that is what a deployment's extensions/package.json actually declares.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

function nodeVersion(): string {
  try {
    return execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'This check needs Node on PATH: it is the runtime the examples are copied into, and Bun cannot stand in '
      + 'for it here — Bun erases the import this test exists to catch.');
  }
}

test('every example loads under Node from outside the repository', async () => {
  nodeVersion();
  const names = (await readdir(examplesDir)).filter((name) => name.endsWith('.ts')).sort();
  assert.ok(names.length > 0, 'no examples found to check');

  const dir = await mkdtemp(join(tmpdir(), 'jobseeker-example-load-'));
  try {
    await cp(examplesDir, join(dir, 'examples'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await symlink(join(repoRoot, 'node_modules', 'valibot'), join(dir, 'node_modules', 'valibot'), 'dir');

    // One subprocess imports them all and reports the first failure with the file that caused it.
    await writeFile(join(dir, 'load-check.mjs'), `
      const names = ${JSON.stringify(names)};
      for (const name of names) {
        let module;
        try {
          module = await import(new URL('./examples/' + name, import.meta.url).href);
        } catch (error) {
          console.error(name + ': ' + error.message);
          process.exit(1);
        }
        if (typeof module.default !== 'function') {
          console.error(name + ': loaded but exports no default register function');
          process.exit(1);
        }
      }
      console.log('loaded ' + names.length);
    `);

    let output: string;
    try {
      output = execFileSync('node', [join(dir, 'load-check.mjs')], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string };
      assert.fail(
        `An example does not load the way a deployment loads it:\n  ${(failure.stderr ?? '').trim()}\n`
        + '  Reach the workspace with `import type { … }`, which is erased, and take values from the injected\n'
        + '  api through ./toolkit.ts. A deployment installs neither @jobseeker/* nor the repository.');
    }
    assert.equal(output.trim(), `loaded ${names.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
