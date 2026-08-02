import { Pool, type PoolClient, type QueryResultRow, type PoolConfig } from 'pg';

let pool: Pool | undefined;

function poolMaximum(): number {
  const raw = process.env.POSTGRES_POOL_MAX ?? '4';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error('POSTGRES_POOL_MAX must be an integer between 1 and 20.');
  }
  return value;
}

export function hasPostgresDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function sslConfig(): PoolConfig['ssl'] {
  const mode = process.env.POSTGRES_SSL ?? 'require';
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') {
    const ca = process.env.POSTGRES_CA_CERT?.replaceAll('\\n', '\n');
    if (!ca) throw new Error('POSTGRES_CA_CERT is required when POSTGRES_SSL=verify-full.');
    return { ca, rejectUnauthorized: true };
  }
  throw new Error('POSTGRES_SSL must be disable, require, or verify-full.');
}

export function getPostgresPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for Postgres persistence.');
  pool ??= new Pool({
    connectionString,
    max: poolMaximum(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslConfig(),
  });
  return pool;
}

export async function postgresQuery<T extends QueryResultRow = QueryResultRow>(text: string,
  params: unknown[] = []): Promise<T[]> {
  return (await getPostgresPool().query<T>(text, params)).rows;
}

export async function withPostgresTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePostgresPool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
