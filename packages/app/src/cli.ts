import { createInterface } from 'node:readline/promises';
import { access, readdir, readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { initializeEmptyPublicSchema, publicUsersTableReady, type StoreAdminClient } from '@jobseeker/store';
import type { AuthType, Credential, CredentialStore, Models } from '@earendil-works/pi-ai';
import { parseConfig, parseModelId, type AppConfig } from './config.ts';
import { parseCredentialDocument } from './ai-auth.ts';
import { packageRootPath } from './deployment-paths.ts';

export interface CliIo { out(message: string): void; error(message: string): void }
export interface DoctorCheck { readonly name: string; readonly ok: boolean; readonly detail: string }
export type CliDatabaseClient = StoreAdminClient;
export interface CliDependencies {
  readonly schemaPath: string;
  readonly fontsPath: string;
  readonly runtimeStart?: () => Promise<void>;
  readonly refreshProfiles?: () => Promise<void>;
  readonly credentialStore?: () => Promise<{ readonly store: CredentialStore; readonly backend: string; readonly close: () => Promise<void> }>;
  readonly credentialModels?: () => Promise<{ readonly models: Models; readonly backend: string; readonly close: () => Promise<void> }>;
  readonly databaseClient?: (config: pg.ClientConfig) => CliDatabaseClient;
  readonly doctorDatabase?: (config: AppConfig) => Promise<boolean>;
  readonly runtimeVersion?: () => { readonly node: string; readonly bun?: string };
}

export const cliHelp = `Usage: jobseeker <command>

Commands:
  start                         Start HTTP, Telegram, workers, and engine ownership
  db init                       Initialize an empty PostgreSQL public schema
  credentials create           Interactively create a provider credential
  credentials [path]           Import provider-keyed credential JSON
  refresh-profiles              Refresh missing approved-user profiles and exit
  doctor                        Check configuration and runtime prerequisites
  help                          Show this help

Ownership warning: run exactly one Telegram receiver per bot token. Polling and webhook must never overlap.`;

function ssl(config: AppConfig): PoolConfig['ssl'] {
  if (config.postgresSsl === 'disable') return false;
  return { rejectUnauthorized: config.postgresSsl === 'verify-full', ...(config.postgresCaCert ? { ca: config.postgresCaCert } : {}) };
}
function defaultIo(): CliIo { return { out: (message) => console.log(message), error: (message) => console.error(message) }; }
function clientFactory(config: pg.ClientConfig): CliDatabaseClient {
  const client = new pg.Client(config);
  return { connect: async () => { await client.connect(); }, query: (sql) => client.query(sql), end: async () => { await client.end(); } };
}

export async function initializeDatabase(input: { readonly config: AppConfig; readonly schemaPath: string;
  readonly createClient?: CliDependencies['databaseClient'] }): Promise<number> {
  if (!input.config.databaseUrl) throw new Error('DATABASE_URL is required.');
  const client = (input.createClient ?? clientFactory)({ connectionString: input.config.databaseUrl, ssl: ssl(input.config),
    options: '-c search_path=public' });
  return initializeEmptyPublicSchema(client, await readFile(input.schemaPath, 'utf8')); 
}

async function pathHas(path: string, pattern: RegExp): Promise<boolean> {
  try { return (await readdir(path)).some((entry) => pattern.test(entry)); } catch { return false; }
}
async function extensionPathHasModule(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isFile() && /\.(?:ts|mts|mjs|js)$/iu.test(entry.name) && !entry.name.endsWith('.d.ts')) return true;
      if (entry.isDirectory()) {
        const children = await readdir(resolve(path, entry.name)).catch(() => []);
        if (children.some((child) => /^index\.(?:ts|mts|mjs|js)$/iu.test(child))) return true;
      }
    }
  } catch { return false; }
  return false;
}
function runtimeAtLeast(version: string | undefined, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version ?? '');
  return match !== null && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
}
export async function doctorChecks(env: Readonly<Record<string, string | undefined>>, dependencies: CliDependencies): Promise<readonly DoctorCheck[]> {
  const required = [
    ['database', env.DATABASE_URL], ['bot token', env.TELEGRAM_BOT_TOKEN], ['owner ID', env.TELEGRAM_USER_ID],
    ['generation model', env.AI_MODEL], ['scoring model', env.AI_SCORING_MODEL],
  ] as const;
  const checks: DoctorCheck[] = required.map(([name, value]) => ({ name: `config:${name}`, ok: Boolean(value?.trim()),
    detail: value?.trim() ? 'configured' : 'missing' }));
  let config: AppConfig | null = null;
  try { config = parseConfig(env); checks.push({ name: 'config:syntax', ok: true, detail: 'valid' }); }
  catch { checks.push({ name: 'config:syntax', ok: false, detail: 'invalid' }); }
  const version = (dependencies.runtimeVersion ?? (() => ({ node: process.versions.node, bun: process.versions.bun })))();
  const nodeOk = runtimeAtLeast(version.node, 23, 6); const bunOk = runtimeAtLeast(version.bun, 1, 3);
  checks.push({ name: 'runtime', ok: nodeOk || bunOk, detail: nodeOk ? `Node ${version.node}` : bunOk ? `Bun ${version.bun}` : 'unsupported' });
  let database = false;
  if (config?.databaseUrl) {
    try { database = await (dependencies.doctorDatabase ?? (async (parsed) => {
      const client = (dependencies.databaseClient ?? clientFactory)({ connectionString: parsed.databaseUrl, ssl: ssl(parsed) });
      return publicUsersTableReady(client);
    }))(config); } catch { database = false; }
  }
  checks.push({ name: 'database', ok: database, detail: database ? 'reachable' : 'unavailable' });
  const fonts = await pathHas(dependencies.fontsPath, /\.(?:ttf|otf)$/iu);
  checks.push({ name: 'fonts', ok: fonts, detail: fonts ? 'available' : 'missing' });
  const extensionsPath = config?.extensionsPath ?? './extensions';
  const extensions = await extensionPathHasModule(extensionsPath);
  checks.push({ name: 'extensions', ok: extensions, detail: extensions ? 'available' : 'missing' });
  return Object.freeze(checks.map((check) => Object.freeze(check)));
}

export async function importCredentials(path: string, dependencies: CliDependencies): Promise<{ readonly backend: string;
  readonly credentials: readonly { readonly providerId: string; readonly type: Credential['type'] }[] }> {
  if (!dependencies.credentialStore) throw new Error('Credential storage is unavailable.');
  const parsed = parseCredentialDocument(JSON.parse(await readFile(path, 'utf8')));
  const backend = await dependencies.credentialStore();
  try {
    const imported: Array<{ providerId: string; type: Credential['type'] }> = [];
    for (const [providerId, credential] of Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right))) {
      await backend.store.modify(providerId, async () => credential); imported.push({ providerId, type: credential.type });
    }
    return Object.freeze({ backend: backend.backend, credentials: Object.freeze(imported.map((item) => Object.freeze(item))) });
  } finally { await backend.close(); }
}

export interface SecretTerminal { readonly isTty: boolean; choose(prompt: string, values: readonly string[]): Promise<string>;
  text(prompt: string): Promise<string>; secret(prompt: string): Promise<string>; notify(message: string): void; close?(): void }
export function nodeSecretTerminal(): SecretTerminal {
  const readline = createInterface({ input: stdin, output: stdout });
  return { isTty: Boolean(stdin.isTTY && stdout.isTTY),
    async choose(prompt, values) { stdout.write(`${prompt}\n${values.map((value, index) => `${index + 1}. ${value}`).join('\n')}\n`);
      const answer = await readline.question('> '); const index = Number(answer) - 1; if (!Number.isSafeInteger(index) || !values[index]) throw new Error('Invalid selection.'); return values[index]!; },
    text: (prompt) => readline.question(`${prompt}: `),
    async secret(prompt) {
      if (!stdin.isTTY) throw new Error('Secret prompt requires a TTY.');
      stdout.write(`${prompt}: `); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
      return new Promise<string>((resolve, reject) => { let value = '';
        const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdout.write('\n'); };
        const onData = (chunk: string) => { if (chunk === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
          if (chunk === '\r' || chunk === '\n') { cleanup(); resolve(value); return; }
          if (chunk === '\u007f') { if (value) { value = value.slice(0, -1); stdout.write('\b \b'); } return; }
          value += chunk; stdout.write('•'); };
        stdin.on('data', onData);
      });
    }, notify: (message) => stdout.write(`${message}\n`), close: () => readline.close() }; 
}

function notifyAuthTerminal(terminal: SecretTerminal, event: Parameters<Parameters<Models['login']>[2]['notify']>[0]): void {
  if (event.type === 'auth_url') { terminal.notify(`Open in your browser: ${event.url}`); return; }
  if (event.type === 'device_code') { terminal.notify(`Open in your browser: ${event.verificationUri}\nCode: ${event.userCode}`); return; }
  if (event.type === 'info') { terminal.notify([event.message, ...(event.links ?? []).map((link) => `${link.label ?? 'Open'}: ${link.url}`)].join('\n')); return; }
  terminal.notify(event.message);
}

export async function createCredentialInteractive(models: Models, terminal: SecretTerminal): Promise<{ providerId: string; type: AuthType }> {
  if (!terminal.isTty) throw new Error('Interactive credential creation requires a TTY.');
  const providers = models.getProviders().filter((provider) => provider.auth.apiKey?.login || provider.auth.oauth);
  const providerId = await terminal.choose('Provider', providers.map((provider) => provider.id));
  const provider = models.getProvider(providerId)!; const methods: AuthType[] = [];
  if (provider.auth.apiKey?.login) methods.push('api_key'); if (provider.auth.oauth) methods.push('oauth');
  const type = await terminal.choose('Authentication method', methods) as AuthType;
  try {
    await models.login(providerId, type, { prompt: async (prompt) => prompt.type === 'secret'
      ? terminal.secret(prompt.message) : prompt.type === 'select'
        ? terminal.choose(prompt.message, prompt.options.map((option) => option.id)) : terminal.text(prompt.message),
    notify: (event) => notifyAuthTerminal(terminal, event) });
    return { providerId, type };
  } finally { terminal.close?.(); }
}

export async function runCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>,
  dependencies: CliDependencies, io: CliIo = defaultIo()): Promise<number> {
  const [command = 'help', subcommand, ...rest] = argv;
  try {
    if (command === 'help' || command === '--help' || command === '-h') { io.out(cliHelp); return 0; }
    if (command === 'start') { if (!dependencies.runtimeStart) throw new Error('Runtime start is unavailable.'); await dependencies.runtimeStart(); return 0; }
    if (command === 'refresh-profiles') { if (!dependencies.refreshProfiles) throw new Error('Profile refresh is unavailable.'); await dependencies.refreshProfiles(); return 0; }
    if (command === 'db' && subcommand === 'init') { const total = await initializeDatabase({ config: parseConfig(env), schemaPath: dependencies.schemaPath,
      createClient: dependencies.databaseClient }); io.out(`Initialized ${total} tables.`); return 0; }
    if (command === 'doctor') { const checks = await doctorChecks(env, dependencies); for (const check of checks) io.out(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`);
      return checks.every((check) => check.ok) ? 0 : 1; }
    if (command === 'credentials' && subcommand === 'create') {
      if (!dependencies.credentialModels) throw new Error('Credential models are unavailable.'); const value = await dependencies.credentialModels();
      try { const result = await createCredentialInteractive(value.models, nodeSecretTerminal()); io.out(`Stored ${result.providerId} (${result.type}) via ${value.backend}.`); }
      finally { await value.close(); } return 0;
    }
    if (command === 'credentials') { const path = subcommand ?? rest[0]; if (!path) throw new Error('Credential import path is required.');
      const imported = await importCredentials(path, dependencies); for (const item of imported.credentials) io.out(`Imported ${item.providerId} (${item.type}) via ${imported.backend}.`); return 0; }
    io.error('Unknown command. Run jobseeker help.'); return 2;
  } catch (error) { io.error(error instanceof Error ? error.message : 'Command failed.'); return 1; }
}

function packageRoot(): string { return packageRootPath(import.meta.url); }
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const root = packageRoot();
  const dependencies: CliDependencies = {
    schemaPath: resolve(root, 'schema.sql'), fontsPath: resolve(root, 'fonts'),
    runtimeStart: async () => { const runtime = await import('./service.ts'); await runtime.startService(); },
    refreshProfiles: async () => { const workflow = await import('./profile-refresh.ts'); const runner = await import('./profile-refresh-runner.ts');
      await runner.refreshMissingProfilesAndExit(workflow.refreshUserProfiles); },
    credentialStore: async () => { const runtime = await import('./service.ts'); return runtime.openCredentialBackend(); },
    credentialModels: async () => { const runtime = await import('./service.ts'); return runtime.openCredentialModels(); },
  };
  return runCli(argv, process.env, dependencies);
}
