/**
 * The `jobseeker` command. `start` boots the full service (Telegram receiver, engine loop, health endpoints) and
 * is the only long-running mode; the rest are operator one-shots that exit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from '@earendil-works/pi-ai';

const usage = `jobseeker — CV-driven vacancy monitoring over Telegram

Usage:
  jobseeker [--env-file <path>] <command>

Commands:
  jobseeker start                Run the service: Telegram bot, engine loop, health endpoints
  jobseeker db init              Apply schema.sql to an empty PostgreSQL database
  jobseeker credentials create   Log in to a model provider: OAuth, or an API key
  jobseeker credentials [path]   Import an existing auth.json into the credential store
  jobseeker refresh-profiles     Generate missing per-platform search profiles for approved users
  jobseeker doctor               Check configuration, database, fonts, and extensions
  jobseeker help                 Show this message

Exactly one running process per bot token may use TELEGRAM_MODE=polling, and the engine loop guards itself with a
PostgreSQL advisory lock. Pass --env-file=.env to load a file; existing process environment values take precedence.`;

function here(): string { return dirname(fileURLToPath(import.meta.url)); }

/** schema.sql sits at the package root: one level above dist/ when built and above src/ in a checkout. */
function schemaPath(): string {
  const path = join(here(), '..', 'schema.sql');
  if (!existsSync(path)) throw new Error(`schema.sql was not found at ${path}.`);
  return path;
}

async function dbInit(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  const { Client } = await import('pg');
  const sslMode = process.env.POSTGRES_SSL ?? 'require';
  const client = new Client({ connectionString: url,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' } });
  await client.connect();
  try {
    const existing = await client.query<{ name: string }>(
      `select tablename as name from pg_tables where schemaname = 'public' order by tablename`);
    if (existing.rows.length) {
      throw new Error(`The database already has ${existing.rows.length} table(s) in public `
        + `(${existing.rows.slice(0, 5).map((row) => row.name).join(', ')}…). `
        + 'db init only initializes an empty database; there is no migration path onto an existing schema.');
    }
    await client.query(readFileSync(schemaPath(), 'utf8'));
    const created = await client.query(`select count(*)::int as count from pg_tables where schemaname = 'public'`);
    console.info(`Schema applied: ${created.rows[0].count} tables created.`);
  } finally { await client.end(); }
}

interface Check { name: string; ok: boolean; detail: string }

async function doctor(): Promise<void> {
  const checks: Check[] = [];
  const need = (name: string): boolean => Boolean(process.env[name]?.trim());
  for (const name of ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_USER_ID', 'AI_MODEL', 'AI_SCORING_MODEL']) {
    checks.push({ name: `env ${name}`, ok: need(name), detail: need(name) ? 'set' : 'missing' });
  }

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = Boolean(process.versions.bun) || major! > 23 || (major === 23 && minor! >= 6);
  checks.push({ name: 'runtime', ok: nodeOk,
    detail: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node} (need ≥ 23.6)` });

  if (need('DATABASE_URL')) {
    try {
      const { Client } = await import('pg');
      const sslMode = process.env.POSTGRES_SSL ?? 'require';
      const client = new Client({ connectionString: process.env.DATABASE_URL,
        ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' } });
      await client.connect();
      const tables = await client.query(`select count(*)::int as count from pg_tables where schemaname = 'public'`);
      const users = await client.query(`select count(*)::int from pg_tables where schemaname='public' and tablename='users'`);
      await client.end();
      const initialized = users.rows[0].count === 1;
      checks.push({ name: 'postgres', ok: initialized,
        detail: initialized ? `reachable, ${tables.rows[0].count} tables` : 'reachable but uninitialized — run jobseeker db init' });
    } catch (error) {
      checks.push({ name: 'postgres', ok: false, detail: String(error instanceof Error ? error.message : error).slice(0, 120) });
    }
  }

  const fontsDir = join(here(), '..', 'fonts');
  const fonts = existsSync(fontsDir);
  checks.push({ name: 'fonts', ok: fonts, detail: fonts ? resolve(fontsDir) : `${fontsDir} does not exist (PDF documents will fail)` });

  const extensionsDir = resolve(process.env.JOBSEEKER_EXTENSIONS ?? './extensions');
  const entries = await readdir(extensionsDir).then((names) => names.filter((name) => !name.startsWith('.'))).catch(() => null);
  checks.push({ name: 'extensions', ok: entries !== null && entries.length > 0,
    detail: entries === null ? `${extensionsDir} does not exist — no vacancy sources will be registered`
      : entries.length ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${extensionsDir}`
        : `${extensionsDir} is empty — no vacancy sources will be registered` });

  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed++;
    console.info(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
  }
  if (failed) { console.error(`\n${failed} check(s) failed.`); process.exitCode = 1; }
  else console.info('\nAll checks passed.');
}

/** The auth.json shape: one type-tagged credential per provider id. */
function parseCredentialDocument(raw: string, source: string): Record<string, Credential> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`${source} is not valid JSON.`, { cause: error }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be an object keyed by provider id.`);
  }
  for (const [providerId, credential] of Object.entries(parsed)) {
    const type = (credential as { type?: unknown } | null)?.type;
    if (type !== 'oauth' && type !== 'api_key') {
      throw new Error(`${source}: entry "${providerId}" has no usable type (expected "oauth" or "api_key").`);
    }
  }
  return parsed as Record<string, Credential>;
}

/**
 * Both credential commands write through the store the service itself uses, and its writes are serialized by a
 * PostgreSQL advisory lock so an import cannot race a running instance mid-refresh. Hence the database.
 */
function requireDatabase(): void {
  if (process.env.DATABASE_URL?.trim()) return;
  throw new Error('DATABASE_URL is required: credential writes are serialized through a PostgreSQL advisory lock '
    + 'so they cannot race a running instance.');
}

/** Where the credential store actually writes, for messages that would otherwise be a guess. */
async function credentialBackend(): Promise<string> {
  const { runtimeStateConfigured } = await import('./runtime-state.ts');
  return runtimeStateConfigured()
    ? `encrypted object storage (${process.env.STATE_STORAGE_BUCKET})`
    : `the local file ${resolve(process.env.AI_AUTH_FILE ?? process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json')}`;
}

async function credentialsImport(path?: string): Promise<void> {
  const source = resolve(path ?? process.env.AI_AUTH_FILE ?? process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
  const document = parseCredentialDocument(await readFile(source, 'utf8').catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT' ? new Error(`No credential file at ${source}.`) : error;
  }), source);
  const entries = Object.entries(document);
  if (!entries.length) throw new Error(`${source} holds no credentials.`);

  const backend = await credentialBackend();
  requireDatabase();
  if (backend.startsWith('the local file') && backend.endsWith(source)) {
    console.info(`${source} is already the credential store; nothing to import.`);
    return;
  }
  const { createCredentialStore } = await import('./ai-auth.ts');
  const store = createCredentialStore();
  for (const [providerId, credential] of entries) await store.modify(providerId, async () => credential);
  console.info(`Imported ${entries.length} credential(s) into ${backend}: `
    + `${entries.map(([providerId, credential]) => `${providerId} (${credential.type})`).join(', ')}.`);
}

/** A visible line of input. The interface is per-prompt so it never competes with the raw-mode secret reader. */
async function askLine(query: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try { return (await rl.question(query, { signal })).trim(); }
  finally { rl.close(); }
}

/**
 * Secrets are read in raw mode and echoed as dots. Readline cannot do this: its line editor owns the echo, and
 * suppressing it through internals put a pasted API key straight into terminal scrollback.
 */
function askSecret(query: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((settle, fail) => {
    const input = process.stdin;
    if (!input.isTTY) { fail(new Error('A secret prompt needs a terminal.')); return; }
    process.stdout.write(query);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    const bytes: number[] = [];
    const done = (): void => {
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      input.off('data', onData);
      signal?.removeEventListener('abort', onAbort);
      process.stdout.write('\n');
    };
    function onAbort(): void { done(); fail(new Error('Prompt aborted.')); }
    function onData(chunk: Buffer): void {
      for (const byte of chunk) {
        if (byte === 0x03) { done(); fail(new Error('Cancelled.')); return; }          // Ctrl-C
        if (byte === 0x0d || byte === 0x0a) { done(); settle(Buffer.from(bytes).toString('utf8').trim()); return; }
        if (byte === 0x7f || byte === 0x08) {                                          // backspace
          if (bytes.pop() !== undefined) process.stdout.write('\b \b');
          continue;
        }
        bytes.push(byte);
        process.stdout.write('•');
      }
    }
    input.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Terminal implementation of pi-ai's login interaction: prompts on stdin, events on stdout. */
function createInteraction(): AuthInteraction {
  const ask = (query: string, options: { secret?: boolean; signal?: AbortSignal }): Promise<string> =>
    options.secret ? askSecret(query, options.signal) : askLine(query, options.signal);

  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === 'select') {
        console.info(`\n${prompt.message}`);
        prompt.options.forEach((option, index) => {
          console.info(`  ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`);
        });
        for (;;) {
          const answer = await ask('Number: ', { signal: prompt.signal });
          const choice = prompt.options[Number(answer) - 1];
          if (choice) return choice.id;
          console.error(`Enter a number between 1 and ${prompt.options.length}.`);
        }
      }
      const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : '';
      return ask(`${prompt.message}${suffix}: `, { secret: prompt.type === 'secret', signal: prompt.signal });
    },
    notify(event: AuthEvent): void {
      if (event.type === 'auth_url') {
        console.info(`\nOpen this URL to authorize:\n  ${event.url}`);
        if (event.instructions) console.info(event.instructions);
      } else if (event.type === 'device_code') {
        console.info(`\nOpen ${event.verificationUri} and enter the code: ${event.userCode}`);
      } else if (event.type === 'info') {
        console.info(event.message);
        for (const link of event.links ?? []) console.info(`  ${link.label ? `${link.label}: ` : ''}${link.url}`);
      } else {
        console.info(event.message);
      }
    },
  };
}

async function credentialsCreate(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('credentials create is interactive; run it from a terminal.');
  requireDatabase();
  const { aiModels } = await import('./ai.ts');
  const providers = aiModels().getProviders()
    .filter((provider) => provider.auth.oauth || provider.auth.apiKey?.login)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!providers.length) throw new Error('No provider offers an interactive login.');

  const interaction = createInteraction();
  {
    const providerId = await interaction.prompt({
      type: 'select',
      message: 'Which provider?',
      options: providers.map((provider) => ({
        id: provider.id,
        label: provider.name,
        description: [provider.auth.oauth ? 'OAuth' : undefined, provider.auth.apiKey?.login ? 'API key' : undefined]
          .filter(Boolean).join(' / '),
      })),
    });
    const provider = providers.find((candidate) => candidate.id === providerId)!;

    const methods = [
      ...(provider.auth.oauth ? [{ id: 'oauth', label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
      ...(provider.auth.apiKey?.login ? [{ id: 'api_key', label: provider.auth.apiKey.name }] : []),
    ];
    const method = methods.length === 1 ? methods[0]!.id
      : await interaction.prompt({ type: 'select', message: `How do you want to sign in to ${provider.name}?`, options: methods });

    const credential = method === 'oauth'
      ? await provider.auth.oauth!.login(interaction)
      : await provider.auth.apiKey!.login!(interaction);

    const { createCredentialStore } = await import('./ai-auth.ts');
    await createCredentialStore().modify(provider.id, async () => credential);
    console.info(`\nStored a ${credential.type} credential for ${provider.id} in ${await credentialBackend()}.`);
    const models = provider.getModels().slice(0, 3).map((model) => `${provider.id}/${model.id}`);
    if (models.length) console.info(`Set AI_MODEL or AI_SCORING_MODEL to one of: ${models.join(', ')}`);
  }
}

const [command, subcommand] = process.argv.slice(2);
try {
  switch (command) {
    case 'start':
      await import('./web.ts');
      break;
    case 'db':
      if (subcommand !== 'init') { console.error(usage); process.exit(2); }
      await dbInit();
      break;
    case 'credentials':
      if (subcommand === 'create') await credentialsCreate();
      else await credentialsImport(subcommand);
      break;
    case 'refresh-profiles':
      await import('./profile-refresh.ts');
      break;
    case 'doctor':
      await doctor();
      break;
    case 'help': case '--help': case '-h': case undefined:
      console.info(usage);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${usage}`);
      process.exit(2);
  }
} catch (error) {
  // One-shot commands report the problem, not a stack trace; `start` keeps running past this point.
  console.error(`jobseeker: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
