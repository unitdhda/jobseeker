#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function envArguments(argv) {
  const paths = []; const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env-file') {
      const path = argv[++index]; if (!path) throw new Error('--env-file requires a path.'); paths.push(path); continue;
    }
    if (value.startsWith('--env-file=')) {
      const path = value.slice('--env-file='.length); if (!path) throw new Error('--env-file requires a path.'); paths.push(path); continue;
    }
    rest.push(value);
  }
  return { paths, rest };
}
function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/u, '').trim();
}
async function loadEnvironment(path) {
  const source = await readFile(path, 'utf8');
  for (const rawLine of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = rawLine.trim(); if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) throw new Error(`Invalid environment line in ${path}.`);
    const key = match[1]; if (Object.hasOwn(process.env, key)) continue;
    process.env[key] = unquote(match[2]);
  }
}

try {
  const { paths, rest } = envArguments(process.argv.slice(2));
  for (const path of paths) await loadEnvironment(path);
  const cli = await import('../dist/cli.js');
  process.exitCode = await cli.main(rest);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Jobseeker launcher failed.');
  process.exitCode = 1;
}
