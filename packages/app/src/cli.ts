/**
 * The `jobseeker` command. `start` boots the full service (Telegram receiver, engine loop, health endpoints) and
 * is the only long-running mode; the rest are operator one-shots that exit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = `jobseeker — CV-driven vacancy monitoring over Telegram

Usage:
  jobseeker start             Run the service: Telegram bot, engine loop, health endpoints
  jobseeker db init           Apply schema.sql to an empty PostgreSQL database
  jobseeker refresh-profiles  Generate missing per-platform search profiles for approved users
  jobseeker doctor            Check configuration, database, fonts, and extensions
  jobseeker help              Show this message

Exactly one running process per bot token may use TELEGRAM_MODE=polling, and the engine loop guards itself with a
PostgreSQL advisory lock. Configuration is environment-only; see the package README.`;

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

  const fontsDir = process.env.TYPST_FONT_PATHS ?? join(here(), '..', 'fonts');
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

const [command, subcommand] = process.argv.slice(2);
switch (command) {
  case 'start':
    await import('./web.ts');
    break;
  case 'db':
    if (subcommand !== 'init') { console.error(usage); process.exit(2); }
    await dbInit();
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
