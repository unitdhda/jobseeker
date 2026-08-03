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

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${errorCode(error)}: ${message.replace(/\s+/g,' ').slice(0,180)}`;
}
export function transientPostgresError(error: unknown): boolean {
  const code=errorCode(error);
  if(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','57P01','57P02','57P03','08000','08001','08003','08004','08006','08007','08P01'].includes(code))return true;
  return /connection terminated|connection timeout|server closed the connection|socket hang up/i.test(error instanceof Error?error.message:String(error));
}
const wait=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

export function getPostgresPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for Postgres persistence.');
  if(pool)return pool;
  const created=new Pool({
    connectionString,
    max: poolMaximum(),
    // AI and document work can run for several minutes between database writes.
    // Keep the session-pooler connection alive instead of reconnecting at the end of each long task.
    idleTimeoutMillis: 15 * 60_000,
    connectionTimeoutMillis: 10_000,
    keepAlive:true,
    keepAliveInitialDelayMillis:10_000,
    ssl: sslConfig(),
  });
  // pg emits transport failures outside the query promise for checked-out and idle clients.
  // Always consume those events so a temporary network reset cannot terminate the worker process.
  created.on('connect',(client)=>client.on('error',(error)=>
    console.warn(`PostgreSQL client connection error: ${errorText(error)}`)));
  created.on('error',(error)=>console.warn(`PostgreSQL idle connection error: ${errorText(error)}`));
  pool=created;
  return created;
}

export async function postgresQuery<T extends QueryResultRow = QueryResultRow>(text: string,
  params: unknown[] = []): Promise<T[]> {
  let lastError:unknown;
  for(let attempt=0;attempt<3;attempt++){
    try{return (await getPostgresPool().query<T>(text, params)).rows;}
    catch(error){
      lastError=error;if(!transientPostgresError(error)||attempt===2)throw error;
      console.warn(`Retrying PostgreSQL query after connection failure (${attempt+1}/2): ${errorText(error)}`);
      await wait(300*2**attempt);
    }
  }
  throw lastError;
}

export async function withPostgresTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  let failure:unknown;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    failure=error;
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally {
    client.release(failure instanceof Error?failure:undefined);
  }
}

export async function persistenceReady(): Promise<'postgres'> {
  await postgresQuery('select 1');
  return 'postgres';
}

export async function closePostgresPool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
