import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResultRow, type PoolConfig } from 'pg';

/** The knobs repositories read through their owning store instance. */
export interface StoreSettings {
  telegramUserId?: string;
  telegramChatId?: string;
  accessRequestCooldownMinutes: number;
  prefilterMaxAgeDays: number;
  searchPlatforms: readonly string[];
  digestMinScore: number;
  alertScore: number;
  timezone: string;
  /** URL hygiene belongs to sources; persistence applies the injected guard defensively. */
  safeVacancyUrl(source: string, url: string): string;
}

export interface StoreOptions {
  /** May be empty at construction; absence only fails when the pool is first needed. */
  databaseUrl: string;
  poolMax: number;
  ssl: PoolConfig['ssl'];
  settings: StoreSettings;
}

export interface StoreRuntime {
  readonly options: StoreOptions;
  pool?: Pool;
}

const currentStore = new AsyncLocalStorage<StoreRuntime>();

export function createStoreRuntime(options: StoreOptions): StoreRuntime {
  return { options };
}

export function runWithStore<T>(runtime: StoreRuntime, operation: () => T): T {
  return currentStore.run(runtime, operation);
}

export function currentStoreRuntime(): StoreRuntime {
  const value = currentStore.getStore();
  if (!value) throw new Error('A store repository was called outside its createStore instance.');
  return value;
}

export function storeSettings(): StoreSettings {
  return currentStoreRuntime().options.settings;
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
  const owner = currentStoreRuntime();
  const connectionString = owner.options.databaseUrl;
  if (!connectionString) throw new Error('DATABASE_URL is required for Postgres persistence.');
  if(owner.pool)return owner.pool;
  const created=new Pool({
    connectionString,
    max: owner.options.poolMax,
    idleTimeoutMillis: 15 * 60_000,
    connectionTimeoutMillis: 10_000,
    keepAlive:true,
    keepAliveInitialDelayMillis:10_000,
    ssl: owner.options.ssl,
  });
  created.on('connect',(client)=>client.on('error',(error)=>
    console.warn(`PostgreSQL client connection error: ${errorText(error)}`)));
  created.on('error',(error)=>console.warn(`PostgreSQL idle connection error: ${errorText(error)}`));
  owner.pool=created;
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

export function withPostgresAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!key) throw new Error('PostgreSQL advisory-lock key is required.');
  return withPostgresTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [key]);
    return fn();
  });
}

export async function persistenceReady(): Promise<'postgres'> {
  await postgresQuery('select 1');
  return 'postgres';
}

export async function closeStoreRuntime(owner: StoreRuntime): Promise<void> {
  const current = owner.pool;
  owner.pool = undefined;
  await current?.end();
}
