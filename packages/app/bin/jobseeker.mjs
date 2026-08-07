#!/usr/bin/env node
// Thin launcher: everything lives in the built CLI bundle next to this file's package.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const built = join(packageRoot, 'dist', 'cli.mjs');
if (existsSync(built)) {
  await import(built);
} else if (process.versions.bun) {
  await import(join(packageRoot, 'src', 'cli.ts'));
} else {
  console.error('jobseeker: dist/cli.mjs is missing. Run the package build (bun run build) first.');
  process.exit(1);
}
