import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { migrationDigest, migrationParameterValue, migrationRowDigest, type MigrationColumn } from '../lib/migration-verification.ts';
import { closePostgresPool, getPostgresPool } from '../lib/postgres.ts';

const copiedTables = [
  'telegram_users','cv_templates','search_profiles','user_delivery_windows','vacancies','user_vacancies',
  'score_alert_details','prefilter_scores','vacancy_candidates','candidate_discoveries',
  'candidate_prefilter_scores','usage_events',
] as const;
const resetOnlyTables = [
  'telegram_update_receipts','telegram_sessions',
  'flue_submission_chunks','flue_attachments','flue_conversation_stream_batches','flue_conversation_streams',
  'flue_agent_submissions',
] as const;
const identityTables = ['vacancies', 'usage_events'] as const;
const sourcePath = resolve(process.env.DATABASE_PATH ?? './data/jobseeker.db');
const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!process.env.DATABASE_URL || !projectRef) throw new Error('DATABASE_URL and SUPABASE_PROJECT_REF are required.');

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}
function sqliteTableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table));
}
function sqliteColumns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`pragma table_info(${identifier(table)})`).all().map((row) => String(row.name));
}
function sqlitePrimaryKeyColumns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`pragma table_info(${identifier(table)})`).all()
    .filter((row) => Number(row.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk)).map((row) => String(row.name));
}
async function sharedTargetColumns(client: PoolClient, sqlite: DatabaseSync, table: string): Promise<MigrationColumn[]> {
  const sourceColumns = new Set(sqliteColumns(sqlite, table));
  const targetResult = await client.query<MigrationColumn>(`select column_name,data_type from information_schema.columns
    where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position`, [table]);
  return targetResult.rows.filter((column) => sourceColumns.has(column.column_name));
}
async function copySharedColumns(client: PoolClient, sqlite: DatabaseSync, table: string): Promise<number> {
  if (!sqliteTableExists(sqlite, table)) return 0;
  const targetColumns = await sharedTargetColumns(client,sqlite,table);
  const columns = targetColumns.map((column) => column.column_name);
  const dataTypes = new Map(targetColumns.map((column) => [column.column_name,column.data_type]));
  if (!columns.length) throw new Error(`No shared columns found for ${table}.`);
  const rows = sqlite.prepare(`select ${columns.map(identifier).join(',')} from ${identifier(table)}`).all();
  const batchSize = Math.max(1, Math.floor(10_000 / columns.length));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize); const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const record = row as Record<string, unknown>;
      return `(${columns.map((column) => {
        values.push(migrationParameterValue(record[column],table,column,dataTypes.get(column)!,record)); return `$${values.length}`;
      }).join(',')})`;
    });
    await client.query(`insert into public.${identifier(table)} (${columns.map(identifier).join(',')}) values ${tuples.join(',')}`, values);
  }
  return rows.length;
}

interface VerificationResult { table: string; samples: number; digest: string }
async function verifyCopiedTableSample(client: PoolClient, sqlite: DatabaseSync, table: string): Promise<VerificationResult> {
  if (!sqliteTableExists(sqlite,table)) return { table, samples: 0, digest: migrationDigest([]) };
  const columns = await sharedTargetColumns(client,sqlite,table);
  const names = columns.map((column) => column.column_name);
  const primaryKey = sqlitePrimaryKeyColumns(sqlite,table);
  if (!primaryKey.length || primaryKey.some((column) => !names.includes(column))) {
    throw new Error(`Cannot sample-verify ${table}: shared primary key not found.`);
  }
  const projection = names.map(identifier).join(',');
  const ordering = primaryKey.map(identifier).join(',');
  const ascending = sqlite.prepare(`select ${projection} from ${identifier(table)} order by ${ordering} limit 5`).all();
  const descending = sqlite.prepare(`select ${projection} from ${identifier(table)} order by ${primaryKey.map((column) => `${identifier(column)} desc`).join(',')} limit 5`).all();
  const selected = new Map<string, Record<string, unknown>>();
  for (const row of [...ascending,...descending] as Array<Record<string, unknown>>) {
    selected.set(JSON.stringify(primaryKey.map((column) => row[column])),row);
  }
  const rowDigests: string[] = [];
  const dataTypes = new Map(columns.map((column) => [column.column_name,column.data_type]));
  for (const source of selected.values()) {
    const values = primaryKey.map((column) => migrationParameterValue(source[column],table,column,dataTypes.get(column)!,source));
    const where = primaryKey.map((column,index) => `${identifier(column)}=$${index + 1}`).join(' and ');
    const target = await client.query<Record<string, unknown>>(`select ${projection} from public.${identifier(table)} where ${where}`,values);
    if (target.rowCount !== 1) throw new Error(`Sample lookup mismatch for ${table}.`);
    const sourceDigest = migrationRowDigest(table,source,columns);
    const targetDigest = migrationRowDigest(table,target.rows[0]!,columns);
    if (sourceDigest !== targetDigest) {
      const mismatched = columns.filter((column) => migrationRowDigest(table,source,[column]) !==
        migrationRowDigest(table,target.rows[0]!,[column])).map((column) => column.column_name);
      throw new Error(`Sample hash mismatch for ${table} columns: ${mismatched.join(',')}.`);
    }
    rowDigests.push(sourceDigest);
  }
  return { table, samples: rowDigests.length, digest: migrationDigest(rowDigests) };
}

async function verifyMergedRows(client: PoolClient, sqlite: DatabaseSync, sourceTable: string,
  mappings: Array<{ source: string; target: string }>, targetPredicate: string): Promise<VerificationResult> {
  if (!sqliteTableExists(sqlite,sourceTable)) return { table: sourceTable, samples: 0, digest: migrationDigest([]) };
  const targetNames = mappings.map(({ target }) => target);
  const metadata = await client.query<MigrationColumn>(`select column_name,data_type from information_schema.columns
    where table_schema='public' and table_name='user_vacancies' and column_name=any($1)`,[targetNames]);
  const typeByTarget = new Map(metadata.rows.map((column) => [column.column_name,column.data_type]));
  const columns = mappings.map(({ source, target }) => ({ column_name: source, data_type: typeByTarget.get(target)! }));
  if (columns.some((column) => !column.data_type)) throw new Error(`Missing merge verification metadata for ${sourceTable}.`);
  const sourceRows = sqlite.prepare(`select ${mappings.map(({ source }) => identifier(source)).join(',')} from ${identifier(sourceTable)}
    order by ${identifier('user_id')},${identifier('vacancy_id')}`).all() as Array<Record<string, unknown>>;
  const aliases = mappings.map(({ source, target }) => `${identifier(target)} as ${identifier(source)}`).join(',');
  const targetRows = (await client.query<Record<string, unknown>>(`select ${aliases} from public.user_vacancies where ${targetPredicate}`)).rows;
  const targetByKey = new Map(targetRows.map((row) => [JSON.stringify([String(row.user_id),String(row.vacancy_id)]),row]));
  const rowDigests = sourceRows.map((source) => {
    const target = targetByKey.get(JSON.stringify([String(source.user_id),String(source.vacancy_id)]));
    if (!target) throw new Error(`Merged sample lookup mismatch for ${sourceTable}.`);
    const sourceDigest = migrationRowDigest(sourceTable,source,columns);
    const targetDigest = migrationRowDigest(sourceTable,target,columns);
    if (sourceDigest !== targetDigest) throw new Error(`Merged row hash mismatch for ${sourceTable}.`);
    return sourceDigest;
  });
  return { table: `${sourceTable}→user_vacancies`, samples: rowDigests.length, digest: migrationDigest(rowDigests) };
}

const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const client = await getPostgresPool().connect();
const summary: Array<{ table: string; rows: number }> = [];
const verification: VerificationResult[] = [];
try {
  await client.query('begin');
  await client.query("set local timezone to 'UTC'");
  await client.query("select pg_advisory_xact_lock(hashtext('jobseeker-sqlite-migration'))");
  const populated: string[] = [];
  for (const table of copiedTables) {
    const result = await client.query(`select count(*)::int count from public.${identifier(table)}`);
    if (Number(result.rows[0]?.count ?? 0) > 0) populated.push(table);
  }
  if (populated.length) {
    const confirmedReset = process.env.MIGRATE_RESET === 'true' && process.env.MIGRATE_CONFIRM_PROJECT_REF === projectRef;
    if (!confirmedReset) throw new Error(`Target application tables are not empty (${populated.join(', ')}). ` +
      'Set MIGRATE_RESET=true and MIGRATE_CONFIRM_PROJECT_REF to the target project ref to replace them.');
  }
  const resetTables = [...copiedTables, ...resetOnlyTables];
  await client.query(`truncate table ${resetTables.reverse().map((table) => `public.${identifier(table)}`).join(', ')} restart identity cascade`);

  for (const table of ['telegram_users','cv_templates','search_profiles','user_delivery_windows','vacancies','user_vacancies'] as const) {
    summary.push({ table, rows: await copySharedColumns(client, sqlite, table) });
  }

  if (sqliteTableExists(sqlite, 'scores')) {
    const scores = sqlite.prepare('select user_id,vacancy_id,score from scores').all() as Array<Record<string, unknown>>;
    for (const row of scores) await client.query(`update user_vacancies set score=$1,
      score_updated_at=coalesce(score_updated_at,updated_at) where user_id=$2 and vacancy_id=$3`,
      [row.score,row.user_id,row.vacancy_id]);
    const count = Number((await client.query('select count(*)::int count from user_vacancies where score is not null')).rows[0]?.count ?? 0);
    if (count !== scores.length) throw new Error(`Score merge mismatch: source=${scores.length}, target=${count}.`);
    summary.push({ table: 'scores→user_vacancies', rows: scores.length });
  }
  if (sqliteTableExists(sqlite, 'applications')) {
    const applications = sqlite.prepare('select user_id,vacancy_id,status,error,requested_at,updated_at from applications').all() as Array<Record<string, unknown>>;
    for (const row of applications) await client.query(`update user_vacancies set application_status=$1,application_error=$2,
      application_requested_at=$3,application_updated_at=$4 where user_id=$5 and vacancy_id=$6`,
      [row.status,row.error,row.requested_at,row.updated_at,row.user_id,row.vacancy_id]);
    const count = Number((await client.query('select count(*)::int count from user_vacancies where application_status is not null')).rows[0]?.count ?? 0);
    if (count !== applications.length) throw new Error(`Application merge mismatch: source=${applications.length}, target=${count}.`);
    summary.push({ table: 'applications→user_vacancies', rows: applications.length });
  }

  for (const table of copiedTables.slice(6)) summary.push({ table, rows: await copySharedColumns(client, sqlite, table) });
  for (const row of summary.filter((item) => !item.table.includes('→'))) {
    const targetCount = Number((await client.query(`select count(*)::int count from public.${identifier(row.table)}`)).rows[0]?.count ?? 0);
    if (targetCount !== row.rows) throw new Error(`Row-count mismatch for ${row.table}: source=${row.rows}, target=${targetCount}.`);
  }
  for (const table of copiedTables) verification.push(await verifyCopiedTableSample(client,sqlite,table));
  verification.push(await verifyMergedRows(client,sqlite,'scores',[
    { source: 'user_id', target: 'user_id' },{ source: 'vacancy_id', target: 'vacancy_id' },{ source: 'score', target: 'score' },
  ],'score is not null'));
  verification.push(await verifyMergedRows(client,sqlite,'applications',[
    { source: 'user_id', target: 'user_id' },{ source: 'vacancy_id', target: 'vacancy_id' },
    { source: 'status', target: 'application_status' },{ source: 'error', target: 'application_error' },
    { source: 'requested_at', target: 'application_requested_at' },{ source: 'updated_at', target: 'application_updated_at' },
  ],'application_status is not null'));
  for (const table of identityTables) await client.query(`select setval(pg_get_serial_sequence('public.${table}','id'),
    coalesce((select max(id) from public.${identifier(table)}),1),exists(select 1 from public.${identifier(table)}))`);

  await client.query('commit');
  for (const row of summary) console.info(`${row.table}: ${row.rows}`);
  for (const result of verification) console.info(`${result.table}: verified ${result.samples} row hashes (${result.digest})`);
  console.info(`Migrated ${summary.reduce((total, row) => total + row.rows, 0)} application rows to project ${projectRef}.`);
} catch (error) {
  await client.query('rollback'); throw error;
} finally {
  client.release(); sqlite.close(); await closePostgresPool();
}
