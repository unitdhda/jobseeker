#!/usr/bin/env node
// Thin launcher: everything lives in the built CLI bundle next to this file's package.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const args = process.argv.slice(2);
const forwarded = [];
let envFile;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--env-file') {
    envFile = args[++index];
    if (!envFile) {
      console.error('jobseeker: --env-file requires a path.');
      process.exit(2);
    }
  } else if (argument.startsWith('--env-file=')) {
    envFile = argument.slice('--env-file='.length);
    if (!envFile) {
      console.error('jobseeker: --env-file requires a path.');
      process.exit(2);
    }
  } else forwarded.push(argument);
}
if (envFile) {
  const path = resolve(envFile);
  let values;
  try { values = parseEnv(readFileSync(path, 'utf8')); }
  catch (error) {
    console.error(`jobseeker: cannot load environment file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  for (const [name, value] of Object.entries(values)) {
    if (value != null && process.env[name] === undefined) process.env[name] = value;
  }
}
process.argv.splice(2, process.argv.length - 2, ...forwarded);

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
