/**
 * The migration rehearsal: prepare a scratch database that contains a restored production dump, transform it the
 * exact way the cutover will, and hold it to the gates. Exit code is the verdict.
 *
 * Usage: SCRATCH_DATABASE_URL=... bun src/scripts/migration/rehearse.ts
 * The URL must point at the scratch instance (see scratch-vps.sh); the tool refuses anything that looks like the
 * production database. `--cutover` disables that guard for the real run — everything else stays identical, which
 * is the point of rehearsing.
 */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { extract, type ExtractCounts } from './extract.ts';
import { gateConservation, gateDedupMemory, gateDeliveryMemory, gateDemand, gateIdempotence, type GateResult } from './gates.ts';

const cutover = process.argv.includes('--cutover');
const url = process.env.SCRATCH_DATABASE_URL;
if (!url) throw new Error('SCRATCH_DATABASE_URL is required (never DATABASE_URL; see scratch-vps.sh).');

const pool = new Pool({ connectionString: url, max: 2,
  ssl: url.includes('sslmode=disable') || url.includes('localhost') || url.includes('127.0.0.1')
    ? false : { rejectUnauthorized: false } });
const client = await pool.connect();
const initialCadenceMinutes = 30;
const similarity = Number(process.env.SEARCH_CLUSTER_SIMILARITY ?? '60') / 100;

try {
  const supabase = (await client.query(`select 1 from information_schema.schemata where schema_name = 'auth'`)).rows.length > 0;
  if (supabase && !cutover) throw new Error('Refusing: target has an auth schema (looks like Supabase). Use --cutover only for the real run.');

  const hasLegacy = (await client.query(`select 1 from information_schema.schemata where schema_name = 'legacy'`)).rows.length > 0;
  if (!hasLegacy) {
    const oldWorld = (await client.query(`select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'user_vacancies'`)).rows.length > 0;
    if (!oldWorld) throw new Error('public has no user_vacancies and no legacy schema exists: nothing to migrate from.');
    console.log('renaming public -> legacy and creating the engine schema');
    await client.query('alter schema public rename to legacy');
    await client.query('create schema public');
    await client.query(await readFile(new URL('./target-schema.sql', import.meta.url), 'utf8'));
  } else {
    console.log('legacy schema already present; resuming into the existing engine schema');
  }

  console.log('extracting');
  await client.query('begin');
  const first = await extract(client, similarity, initialCadenceMinutes);
  await client.query('commit');
  for (const entry of first) console.log(`  ${entry.table}: ${entry.copied}`);

  console.log('re-running extract for Gate E');
  await client.query('begin');
  const second: ExtractCounts[] = await extract(client, similarity, initialCadenceMinutes);
  await client.query('commit');

  const results: GateResult[] = [
    ...await gateConservation(client),
    ...await gateDeliveryMemory(client),
    ...await gateDedupMemory(client),
    ...await gateDemand(client),
    ...gateIdempotence(second),
  ];
  console.log('\ngates:');
  for (const result of results) console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.gate}  ${result.detail}`);
  const failed = results.filter((result) => !result.ok);
  console.log(failed.length ? `\nREHEARSAL FAILED: ${failed.length} gate(s)` : '\nREHEARSAL PASSED');
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
