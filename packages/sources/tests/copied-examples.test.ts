import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { exampleSourceIds } from '../examples/catalogue.ts';
import { loadExtensionsFrom, type JobseekerExtensionApi } from '../../app/src/extensions.ts';
import type { SourceExtensionApi } from '../examples/toolkit.ts';

const _appApiSatisfiesCopiedExamples: JobseekerExtensionApi extends SourceExtensionApi ? true : never = true;
void _appApiSatisfiesCopiedExamples;

test('example catalogue contains exactly the required unique provider IDs', () => {
  assert.deepEqual(exampleSourceIds, [
    'habr', 'rabota', 'hirehi', 'geekjob', 'avito', 'trudvsem', 'ats', 'yandex', 'ozon', 'rwb',
    'mts', 'vk', 'kontur', 'magnit', 'yadro', 'selectel', 'sber', 'kaspersky', 'tbank',
  ]);
  assert.equal(new Set(exampleSourceIds).size, 19);
  assert.equal(Object.isFrozen(exampleSourceIds), true);
});

test('whole copied catalogue loads outside the monorepo with only valibot installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-whole-catalogue-'));
  try {
    await cp(resolve('packages/sources/examples'), join(root, 'examples'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink('/Users/uf90/work/jobseeker/node_modules/valibot', join(root, 'node_modules', 'valibot'));
    const loaded = await loadExtensionsFrom(root, { env: {} });
    assert.deepEqual(loaded.names, ['examples']);
    assert.deepEqual(loaded.sourceProviders.map((provider) => provider.id), exampleSourceIds);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('combining whole catalogue and flat provider copies fails on duplicate IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-mixed-catalogue-'));
  try {
    await cp(resolve('packages/sources/examples'), join(root, 'examples'), { recursive: true });
    for (const file of ['habr.ts', 'board-example.ts', 'text.ts', 'toolkit.ts']) {
      await cp(resolve('packages/sources/examples', file), join(root, file));
    }
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink('/Users/uf90/work/jobseeker/node_modules/valibot', join(root, 'node_modules', 'valibot'));
    await assert.rejects(() => loadExtensionsFrom(root, { env: {} }), /Duplicate source provider ID: habr/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('copied toolkit runs outside the monorepo with only valibot installed and injected runtime values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-copied-example-'));
  try {
    await cp(resolve('packages/sources/examples/toolkit.ts'), join(root, 'toolkit.ts'));
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink('/Users/uf90/work/jobseeker/node_modules/valibot', join(root, 'node_modules', 'valibot'));
    await writeFile(join(root, 'provider.ts'), `
      import * as v from 'valibot';
      import { initToolkit, createSourceProvider } from './toolkit.ts';
      export default function register(api) {
        initToolkit(api);
        api.registerSourceProvider(createSourceProvider({
          id: 'fixture', name: 'Fixture', hosts: ['fixture.example.test'],
          schema: v.strictObject({ searches: v.array(v.unknown()) }),
          template: () => ({ platform: 'fixture', version: 1, purpose: 'test', jsonShape: {}, capabilities: {}, rules: [] }),
          discover: async () => ({ searches: 0, users: 0, seen: 0, discovered: 0 }),
          normalize: async () => new Map(),
        }));
      }
    `);
    await writeFile(join(root, 'run.ts'), `
      const registered = [];
      const createSourceProvider = input => Object.freeze(input);
      const noop = () => {};
      const api = {
        registerSourceProvider: provider => registered.push(provider), env: {},
        sources: {
          asObject: value => value, createSourceProvider, hashedVacancy: noop, htmlText: String,
          jobPostings: () => [], parseSalaryText: noop, plainText: String, russianDate: noop,
          structuredLocation: noop, structuredVacancy: noop, VacancySearchCollector: class {},
          drivers: {
            api: { createApiSource: noop },
            ats: { atsHosts: [], atsSearchProfileSchema: {}, configuredBoards: noop, createAtsSource: noop, postingMatchesQuery: noop },
            companySite: { companyVacancyInput: noop, createCompanySiteSource: noop, mainVacancyText: noop },
            jsonLdBoard: { createJsonLdBoardSource: noop },
          },
        },
      };
      const { default: register } = await import('./provider.ts');
      register(api);
      console.log(JSON.stringify(registered.map(provider => provider.id)));
    `);
    const child = spawn(process.execPath, [join(root, 'run.ts')], {
      cwd: root, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit); child.once('exit', resolveExit);
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), ['fixture']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
