import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import pg, {
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

export interface StoreSettings {
  readonly telegramUserId?: string;
  readonly accessRequestCooldownMinutes: number;
  readonly prefilterMaxAgeDays: number;
  readonly searchPlatforms: readonly string[];
  readonly digestMinScore: number;
  readonly alertScore: number;
  readonly timezone: string;
  safeVacancyUrl(source: string, url: string): string;
}

export interface StoreOptions {
  readonly databaseUrl: string;
  readonly poolMax: number;
  readonly ssl: PoolConfig['ssl'];
  readonly settings: StoreSettings;
}

interface Queryable {
  query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TRow>>;
}

interface ReleasableClient extends Queryable {
  release(error?: Error | boolean): void;
}

interface SingletonClient extends Queryable {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

interface PoolLike extends Queryable {
  connect(): Promise<ReleasableClient>;
  end(): Promise<void>;
}

export interface StoreRuntimeDependencies {
  createPool(config: PoolConfig): PoolLike;
  createClient(config: PoolConfig): SingletonClient;
  sleep(milliseconds: number): Promise<void>;
}

export interface StoreRuntime {
  readonly id: symbol;
  readonly options: StoreOptions;
  readonly settings: StoreSettings;
  readonly dependencies: StoreRuntimeDependencies;
  pool?: PoolLike;
  readonly singletonClients: Set<SingletonClient>;
  closed: boolean;
  closePromise?: Promise<void>;
}

const defaults: StoreRuntimeDependencies = {
  createPool: (config) => new pg.Pool(config) as PoolLike,
  createClient: (config) => new pg.Client(config) as unknown as SingletonClient,
  sleep: async (milliseconds) => { await sleep(milliseconds); },
};
const owners = new AsyncLocalStorage<StoreRuntime>();

function assertSettings(settings: StoreSettings): void {
  const positiveInteger = (value: number, name: string): void => {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Invalid store ${name}: expected a positive safe integer, received ${value}.`);
    }
  };
  positiveInteger(settings.accessRequestCooldownMinutes, 'access cooldown');
  positiveInteger(settings.prefilterMaxAgeDays, 'prefilter maximum age');
  for (const [name, score] of [['digest score', settings.digestMinScore], ['alert score', settings.alertScore]] as const) {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new RangeError(`Invalid store ${name}: expected a finite number from 0 through 100, received ${score}.`);
    }
  }
  if (settings.digestMinScore > settings.alertScore) {
    throw new RangeError('Invalid store scores: digest minimum must not exceed alert score.');
  }
  if (!settings.timezone.trim()) throw new TypeError('Invalid store timezone: expected a nonempty string.');
  if (new Set(settings.searchPlatforms).size !== settings.searchPlatforms.length
    || settings.searchPlatforms.some((platform) => !platform.trim())) {
    throw new TypeError('Invalid store search platforms: expected unique nonempty IDs.');
  }
  if (settings.telegramUserId !== undefined && !/^[1-9]\d*$/u.test(settings.telegramUserId)) {
    throw new TypeError('Invalid store Telegram owner ID.');
  }
  if (typeof settings.safeVacancyUrl !== 'function') throw new TypeError('Invalid store safe URL policy.');
}

export function createStoreRuntime(
  options: StoreOptions,
  dependencies: StoreRuntimeDependencies = defaults,
): StoreRuntime {
  if (!options.databaseUrl.trim()) throw new TypeError('Invalid store database URL: expected a nonempty string.');
  if (!Number.isSafeInteger(options.poolMax) || options.poolMax < 1) {
    throw new RangeError(`Invalid store pool maximum: expected a positive safe integer, received ${options.poolMax}.`);
  }
  assertSettings(options.settings);
  return {
    id: Symbol('StoreRuntime'),
    options,
    settings: Object.freeze({ ...options.settings, searchPlatforms: Object.freeze([...options.settings.searchPlatforms]) }),
    dependencies,
    singletonClients: new Set(),
    closed: false,
  };
}

export function runWithStore<TResult>(runtime: StoreRuntime, operation: () => TResult): TResult {
  return owners.run(runtime, operation);
}

export function currentStoreRuntime(): StoreRuntime {
  const runtime = owners.getStore();
  if (!runtime) throw new Error('Store repository call has no owning store runtime.');
  if (runtime.closed) throw new Error('Store runtime is closed.');
  return runtime;
}

export function storeSettings(): StoreSettings {
  return currentStoreRuntime().settings;
}

function poolConfig(runtime: StoreRuntime): PoolConfig {
  return {
    connectionString: runtime.options.databaseUrl,
    max: runtime.options.poolMax,
    ssl: runtime.options.ssl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    allowExitOnIdle: false,
  };
}

/** Pool creation is intentionally deferred until the first SQL operation, not store construction. */
export function getPostgresPool(runtime: StoreRuntime = currentStoreRuntime()): PoolLike {
  if (runtime.closed) throw new Error('Store runtime is closed.');
  runtime.pool ??= runtime.dependencies.createPool(poolConfig(runtime));
  return runtime.pool;
}

const transientCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
]);

export function transientPostgresError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
  return transientCodes.has(code);
}

export class StoreConnectionError extends Error {
  readonly operation: string;
  readonly code?: string;

  constructor(operation: string, cause: unknown) {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
    super(`PostgreSQL ${operation} failed${code ? ` (${code})` : ''}.`, { cause });
    this.name = 'StoreConnectionError';
    this.operation = operation;
    this.code = code;
  }
}

export async function postgresQuery<TRow extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<TRow>> {
  const runtime = currentStoreRuntime();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const pool = getPostgresPool(runtime);
      return values.length > 0 ? await pool.query<TRow>(text, values) : await pool.query<TRow>(text);
    } catch (error) {
      if (attempt === 2 || !transientPostgresError(error)) throw new StoreConnectionError('query', error);
      await runtime.dependencies.sleep(50 * 2 ** attempt);
    }
  }
  throw new Error('Unreachable PostgreSQL retry state.');
}

export async function withPostgresTransaction<TResult>(
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await getPostgresPool().connect() as unknown as PoolClient;
  let poisoned = false;
  try {
    await client.query('begin');
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      poisoned = true;
    }
    throw error;
  } finally {
    // A client whose rollback failed may still be in a transaction; pg must destroy rather than reuse it.
    client.release(poisoned);
  }
}

export function withPostgresAdvisoryLock<TResult>(
  key: string,
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  if (!key) throw new TypeError('Invalid advisory lock key: expected a nonempty string.');
  return withPostgresTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    return operation(client);
  });
}

export async function tryAcquireSingletonLock(
  runtime: StoreRuntime,
  key: string,
): Promise<(() => Promise<void>) | null> {
  if (!key) throw new TypeError('Invalid singleton lock key: expected a nonempty string.');
  if (runtime.closed) throw new Error('Store runtime is closed.');
  const client = runtime.dependencies.createClient(poolConfig(runtime));
  try {
    await client.connect();
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) locked',
      [key],
    );
    if (!result.rows[0]?.locked) {
      await client.end();
      return null;
    }
    runtime.singletonClients.add(client);
    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      runtime.singletonClients.delete(client);
      try {
        await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } finally {
        await client.end();
      }
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new StoreConnectionError('singleton lock', error);
  }
}

export async function persistenceReady(): Promise<'postgres'> {
  await postgresQuery('select 1');
  return 'postgres';
}

export async function closeStoreRuntime(runtime: StoreRuntime): Promise<void> {
  if (runtime.closePromise) return runtime.closePromise;
  runtime.closed = true;
  runtime.closePromise = (async () => {
    const clients = [...runtime.singletonClients];
    runtime.singletonClients.clear();
    await Promise.allSettled(clients.map((client) => client.end()));
    if (runtime.pool) await runtime.pool.end();
  })();
  return runtime.closePromise;
}
