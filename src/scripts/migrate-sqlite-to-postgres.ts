import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { closePostgresPool, getPostgresPool } from '../lib/postgres.ts';

const tables = [
  'telegram_users',
  'app_migrations',
  'cv_templates',
  'search_profiles',
  'global_scheduler_settings',
  'user_delivery_windows',
  'pending_deliveries',
  'vacancies',
  'user_vacancies',
  'scores',
  'score_alert_details',
  'prefilter_scores',
  'embedding_cache',
  'vacancy_candidates',
  'candidate_discoveries',
  'candidate_prefilter_scores',
  'applications',
  'usage_events',
] as const;

const identityTables = ['vacancies', 'usage_events'] as const;
const sourcePath = resolve(process.env.DATABASE_PATH ?? './data/jobseeker.db');
const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!process.env.DATABASE_URL || !projectRef) {
  throw new Error('DATABASE_URL and SUPABASE_PROJECT_REF are required.');
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function sqliteColumns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map((row) => String(row.name));
}

function parameterValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value === undefined ? null : value;
}

const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const pool = getPostgresPool();
const client = await pool.connect();
const summary: Array<{ table: string; rows: number }> = [];

try {
  await client.query('BEGIN');
  await client.query("select pg_advisory_xact_lock(hashtext('jobseeker-sqlite-migration'))");

  const populated: string[] = [];
  for (const table of tables) {
    const result = await client.query(`select count(*)::int count from public.${identifier(table)}`);
    if (Number(result.rows[0]?.count ?? 0) > 0) populated.push(table);
  }
  if (populated.length) {
    const confirmedReset = process.env.MIGRATE_RESET === 'true'
      && process.env.MIGRATE_CONFIRM_PROJECT_REF === projectRef;
    if (!confirmedReset) {
      throw new Error(`Target application tables are not empty (${populated.join(', ')}). ` +
        'Set MIGRATE_RESET=true and MIGRATE_CONFIRM_PROJECT_REF to the target project ref to replace them.');
    }
    await client.query(`truncate table ${[...tables].reverse().map((table) => `public.${identifier(table)}`).join(', ')} restart identity cascade`);
  }

  for (const table of tables) {
    const sourceColumns = new Set(sqliteColumns(sqlite, table));
    const targetResult = await client.query<{ column_name: string }>(`select column_name from information_schema.columns
      where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position`, [table]);
    const columns = targetResult.rows.map((row) => row.column_name).filter((column) => sourceColumns.has(column));
    if (!columns.length) throw new Error(`No shared columns found for ${table}.`);
    const rows = sqlite.prepare(`select ${columns.map(identifier).join(',')} from ${identifier(table)}`).all();
    const batchSize = Math.max(1, Math.floor(10_000 / columns.length));
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const tuples = batch.map((row) => {
        const record = row as Record<string, unknown>;
        const placeholders = columns.map((column) => {
          values.push(parameterValue(record[column]));
          return `$${values.length}`;
        });
        return `(${placeholders.join(',')})`;
      });
      await client.query(`insert into public.${identifier(table)} (${columns.map(identifier).join(',')}) values ${tuples.join(',')}`, values);
    }
    const targetCount = Number((await client.query(`select count(*)::int count from public.${identifier(table)}`)).rows[0]?.count ?? 0);
    if (targetCount !== rows.length) throw new Error(`Row-count mismatch for ${table}: source=${rows.length}, target=${targetCount}.`);
    summary.push({ table, rows: rows.length });
  }

  for (const table of identityTables) {
    await client.query(`select setval(pg_get_serial_sequence('public.${table}','id'),
      coalesce((select max(id) from public.${identifier(table)}),1),
      exists(select 1 from public.${identifier(table)}))`);
  }

  await client.query('COMMIT');
  for (const row of summary) console.info(`${row.table}: ${row.rows}`);
  console.info(`Migrated ${summary.reduce((total, row) => total + row.rows, 0)} application rows to project ${projectRef}.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  sqlite.close();
  await closePostgresPool();
}
