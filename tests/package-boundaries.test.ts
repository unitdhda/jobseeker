import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function typescriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

async function matches(root: string, pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const file of await typescriptFiles(root)) {
    if (pattern.test(await readFile(file, 'utf8'))) found.push(file);
    pattern.lastIndex = 0;
  }
  return found;
}

test('the monorepo has exactly the four domain workspaces', async () => {
  const workspaces=(await readdir('packages',{withFileTypes:true})).filter(entry=>entry.isDirectory())
    .map(entry=>entry.name).sort();
  assert.deepEqual(workspaces,['cv','engine','sources','store']);
  const expected:Record<string,string[]>={cv:[],engine:[],sources:['@jobseeker/engine'],
    store:['@jobseeker/cv','@jobseeker/engine']};
  for(const name of workspaces){
    const manifest=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8')) as {dependencies?:Record<string,string>};
    assert.deepEqual(Object.keys(manifest.dependencies??{}).filter(key=>key.startsWith('@jobseeker/')).sort(),expected[name]);
  }
});

test('workspace packages never read application environment or import the root application', async () => {
  assert.deepEqual(await matches('packages', /\b(?:process|Bun)\.env\b|import\.meta\.env/), []);
  assert.deepEqual(await matches('packages', /from\s+['"][^'"]*(?:\.\.\/){2,}src\//), []);
});

test('source and engine dependency directions stay inverted', async () => {
  assert.deepEqual(await matches('packages/sources', /@jobseeker\/(?:store|cv)/), []);
  assert.deepEqual(await matches('packages/engine', /@jobseeker\/(?:store|sources|cv)/), []);
  assert.deepEqual(await matches('packages', /\bconfigure(?:Store|Sources)\b/), []);
});

test('application runtime does not issue raw PostgreSQL queries', async () => {
  const files = (await matches('src', /\b(?:postgresQuery|withPostgresTransaction|getPostgresPool)\b/))
    .filter((file) => !file.includes('/scripts/'));
  assert.deepEqual(files, []);
});

test('adapter identity is registry-owned rather than duplicated as database allowlists', async () => {
  for (const file of ['supabase/schema.sql', 'src/scripts/migration/target-schema.sql']) {
    const schema = await readFile(file, 'utf8');
    assert.doesNotMatch(schema, /constraint (?:vacancies_source|search_units_platform)_check/i, file);
  }
});
