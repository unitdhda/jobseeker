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

const domainPackages = ['cv', 'engine', 'sources', 'store'];

test('the monorepo has the four domain workspaces plus the application package', async () => {
  const workspaces=(await readdir('packages',{withFileTypes:true})).filter(entry=>entry.isDirectory())
    .map(entry=>entry.name).sort();
  assert.deepEqual(workspaces,['app','cv','engine','sources','store']);
  const expected:Record<string,string[]>={app:['@jobseeker/cv','@jobseeker/engine','@jobseeker/sources','@jobseeker/store'],
    cv:[],engine:[],sources:['@jobseeker/engine'],
    store:['@jobseeker/cv','@jobseeker/engine']};
  for(const name of workspaces){
    const manifest=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8')) as
      {dependencies?:Record<string,string>;devDependencies?:Record<string,string>};
    // app bundles its workspaces at build time, so they are devDependencies of the published package.
    const all={...manifest.dependencies,...manifest.devDependencies};
    assert.deepEqual(Object.keys(all).filter(key=>key.startsWith('@jobseeker/')).sort(),expected[name]);
  }
});

test('domain packages never read application environment or import the application package', async () => {
  for (const name of domainPackages) {
    assert.deepEqual(await matches(`packages/${name}`, /\b(?:process|Bun)\.env\b|import\.meta\.env/), []);
    assert.deepEqual(await matches(`packages/${name}`, /@unitdhda\/jobseeker|(?:\.\.\/)+app\/src\//), []);
  }
});

test('source and engine dependency directions stay inverted', async () => {
  assert.deepEqual(await matches('packages/sources', /@jobseeker\/(?:store|cv)/), []);
  assert.deepEqual(await matches('packages/sources/examples', /@jobseeker\/store|from\s+['"][^'"]*postgres|\b(?:process|Bun)\.env\b/), []);
  assert.deepEqual(await matches('packages/engine', /@jobseeker\/(?:store|sources|cv)/), []);
  assert.deepEqual(await matches('packages', /\bconfigure(?:Store|Sources)\b/), []);
});

test('the sources package exposes runtime and generic drivers, not an application provider catalogue', async () => {
  const index = await readFile('packages/sources/src/index.ts', 'utf8');
  assert.doesNotMatch(index, /from ['"].*(?:providers\/|registry\.ts)/);
  const manifest = JSON.parse(await readFile('packages/sources/package.json', 'utf8')) as {
    exports: Record<string, string>; dependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './drivers/*', './examples/*']);
  assert.equal(manifest.dependencies.playwright, undefined);
  const files = await typescriptFiles('packages/sources/src');
  for (const source of ['hh.ts', 'hirehi.ts', 'ats.ts', 'trudvsem.ts', 'additional.ts']) {
    assert.ok(!files.includes(`packages/sources/src/${source}`), `${source} belongs to the root application`);
  }
});

test('source runtime has no ambient state or provider-specific settings', async () => {
  const runtime = await readFile('packages/sources/src/context.ts', 'utf8');
  assert.doesNotMatch(runtime, /AsyncLocalStorage|hhAreaId|hhBrowser|atsBoards|trudvsemRegion|additionalMaxPages/);
  assert.match(runtime, /interface SourceContext/);
});

test('application runtime does not issue raw PostgreSQL queries', async () => {
  const files = (await matches('packages/app/src', /\b(?:postgresQuery|withPostgresTransaction|getPostgresPool)\b/))
    .filter((file) => !file.includes('/scripts/'));
  assert.deepEqual(files, []);
});

test('adapter identity is provider-collection-owned rather than duplicated as allowlists', async () => {
  for (const file of ['packages/app/schema.sql']) {
    const schema = await readFile(file, 'utf8');
    assert.doesNotMatch(schema, /constraint (?:vacancies_source|search_units_platform)_check/i, file);
  }
  const config = await readFile('packages/app/src/config.ts', 'utf8');
  assert.doesNotMatch(config, /supportedSearchPlatforms|builtinSourceProviderIds/);
  const composition = await readFile('packages/app/src/vacancies/providers.ts', 'utf8');
  assert.match(composition, /extensions\.sourceProviders/);
});
