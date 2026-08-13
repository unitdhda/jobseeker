import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Credential, Models } from '@earendil-works/pi-ai';
import { createCredentialInteractive, doctorChecks, importCredentials, initializeDatabase, runCli,
  type CliDependencies, type SecretTerminal } from '../src/cli.ts';
import { parseConfig } from '../src/config.ts';

const base = (root: string): CliDependencies => ({ schemaPath: join(root, 'schema.sql'), fontsPath: join(root, 'fonts') });

test('db init rejects nonempty public, applies whole schema transactionally, and always closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-cli-')); await writeFile(join(root, 'schema.sql'), 'create table users(id int);');
  try {
    const calls: string[] = []; let count = 0;
    const total = await initializeDatabase({ config: parseConfig({ DATABASE_URL: 'postgres://example/db', TELEGRAM_MODE: 'off' }), schemaPath: join(root, 'schema.sql'),
      createClient: () => ({ connect: async () => { calls.push('connect'); }, end: async () => { calls.push('end'); },
        query: async <TRow>(sql: string) => { calls.push(sql); return { rows: (sql.includes('information_schema')
          ? [{ total: String(count++ ? 1 : 0) }] : []) as TRow[] }; } }) });
    assert.equal(total, 1); assert.deepEqual(calls, ['connect', calls[1]!, 'begin', 'create table users(id int);', 'commit', calls[5]!, 'end']);
    const nonempty: string[] = [];
    await assert.rejects(initializeDatabase({ config: parseConfig({ DATABASE_URL: 'postgres://example/db', TELEGRAM_MODE: 'off' }), schemaPath: join(root, 'schema.sql'),
      createClient: () => ({ connect: async () => undefined, end: async () => { nonempty.push('end'); },
        query: async <TRow>() => ({ rows: [{ total: '1' }] as TRow[] }) }) }), /not empty/u);
    assert.deepEqual(nonempty, ['end']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor reports check names/status only, enforces runtime minima, and accepts indexed extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-doctor-')); await mkdir(join(root, 'fonts')); await writeFile(join(root, 'fonts', 'font.ttf'), 'x');
  const extensions = join(root, 'extensions'); await mkdir(join(extensions, 'hh'), { recursive: true }); await writeFile(join(extensions, 'hh', 'index.ts'), 'export default () => {};');
  try {
    const checks = await doctorChecks({ TELEGRAM_MODE: 'off', JOBSEEKER_EXTENSIONS: extensions },
      { ...base(root), runtimeVersion: () => ({ node: '23.5.9', bun: '1.3.0' }), doctorDatabase: async () => false });
    assert.equal(checks.some((check) => !check.ok), true); assert.equal(JSON.stringify(checks).includes('postgres://'), false);
    assert.ok(checks.some((check) => check.name === 'config:database' && !check.ok));
    assert.ok(checks.some((check) => check.name === 'runtime' && check.ok && check.detail === 'Bun 1.3.0'));
    assert.ok(checks.some((check) => check.name === 'extensions' && check.ok));
    const unsupported = await doctorChecks({ TELEGRAM_MODE: 'off', JOBSEEKER_EXTENSIONS: extensions },
      { ...base(root), runtimeVersion: () => ({ node: '23.5.9', bun: '1.2.9' }), doctorDatabase: async () => false });
    assert.ok(unsupported.some((check) => check.name === 'runtime' && !check.ok));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential import validates provider-keyed shapes and reports no values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-credentials-')); const path = join(root, 'auth.json');
  await writeFile(path, JSON.stringify({ anthropic: { type: 'api_key', key: 'TOP_SECRET' }, openai: { type: 'oauth', refresh: 'R', access: 'A', expires: 1 } }));
  const saved = new Map<string, Credential>();
  try {
    const result = await importCredentials(path, { ...base(root), credentialStore: async () => ({ backend: 'file', close: async () => undefined,
      store: { read: async () => undefined, list: async () => [], delete: async () => undefined,
        modify: async (id, fn) => { const value = await fn(saved.get(id)); if (value) saved.set(id, value); return value; } } }) });
    assert.deepEqual(result, { backend: 'file', credentials: [{ providerId: 'anthropic', type: 'api_key' }, { providerId: 'openai', type: 'oauth' }] });
    assert.equal(JSON.stringify(result).includes('TOP_SECRET'), false); assert.equal(saved.size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interactive credential creation delegates secret input, reports OAuth instructions, and closes terminal', async () => {
  const choices = ['example', 'oauth']; const notifications: string[] = []; let closed = 0; let secretPrompts = 0;
  const terminal: SecretTerminal = { isTty: true, choose: async () => choices.shift()!, text: async () => 'text',
    secret: async () => { secretPrompts += 1; return 'TOP_SECRET'; }, notify: (value) => { notifications.push(value); }, close: () => { closed += 1; } };
  const provider = { id: 'example', auth: { apiKey: { login: async () => ({ type: 'api_key' as const }) }, oauth: {} } };
  const models = { getProviders: () => [provider], getProvider: () => provider,
    login: async (_id: string, _type: string, interaction: { prompt(value: { type: 'secret'; message: string }): Promise<string>;
      notify(value: { type: 'auth_url'; url: string } | { type: 'device_code'; verificationUri: string; userCode: string }): void }) => {
      assert.equal(await interaction.prompt({ type: 'secret', message: 'API key' }), 'TOP_SECRET');
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/login?request=1' });
      interaction.notify({ type: 'device_code', verificationUri: 'https://auth.example/device', userCode: 'ABCD' });
      return { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } as const;
    } } as unknown as Models;
  assert.deepEqual(await createCredentialInteractive(models, terminal), { providerId: 'example', type: 'oauth' });
  assert.equal(secretPrompts, 1); assert.equal(closed, 1);
  assert.deepEqual(notifications, ['Open in your browser: https://auth.example/login?request=1', 'Open in your browser: https://auth.example/device\nCode: ABCD']);
  assert.equal(JSON.stringify(notifications).includes('TOP_SECRET'), false);
});

test('CLI dispatch returns stable codes and help includes receiver ownership warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobseeker-dispatch-')); const out: string[] = []; const errors: string[] = [];
  try {
    assert.equal(await runCli(['help'], {}, base(root), { out: (v) => out.push(v), error: (v) => errors.push(v) }), 0);
    assert.match(out[0]!, /exactly one Telegram receiver/u);
    assert.equal(await runCli(['unknown'], {}, base(root), { out: (v) => out.push(v), error: (v) => errors.push(v) }), 2);
    assert.equal(await runCli(['start'], {}, base(root), { out: (v) => out.push(v), error: (v) => errors.push(v) }), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
