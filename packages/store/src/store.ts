import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import * as engineRepos from './engine-repos.ts';
import * as repos from './repos.ts';
import * as telegramRepos from './telegram-repos.ts';
import {
  closeStoreRuntime,
  createStoreRuntime,
  getPostgresPool,
  persistenceReady,
  postgresQuery,
  runWithStore,
  tryAcquireSingletonLock,
  withPostgresAdvisoryLock,
  withPostgresTransaction,
  type StoreOptions,
  type StoreRuntime,
  type StoreRuntimeDependencies,
  type SingletonLease,
} from './client.ts';

export interface StoreAdmin {
  readonly pool: Pool;
  query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TRow>>;
  transaction<TResult>(operation: (client: PoolClient) => Promise<TResult>): Promise<TResult>;
}

export interface StoreLifecycle {
  readonly settings: StoreOptions['settings'];
  readonly admin: StoreAdmin;
  ready(): Promise<'postgres'>;
  close(): Promise<void>;
  withAdvisoryLock<TResult>(key: string, operation: (client: PoolClient) => Promise<TResult>): Promise<TResult>;
  tryAcquireSingletonLock(key: string): Promise<SingletonLease | null>;
}

function storeProxy<TTarget extends object>(runtime: StoreRuntime, target: TTarget): TTarget {
  const wrappers = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      let wrapper = wrappers.get(property);
      if (!wrapper) {
        wrapper = (...args: unknown[]) => runWithStore(runtime, () => Reflect.apply(value, current, args));
        wrappers.set(property, wrapper);
      }
      return wrapper;
    },
  });
}

export type StoreRepositories = typeof repos & typeof engineRepos & typeof telegramRepos;
export type Store = StoreLifecycle & StoreRepositories;

function buildStore(runtime: StoreRuntime): Store {
  const admin: StoreAdmin = Object.freeze({
    get pool(): Pool {
      return getPostgresPool(runtime) as unknown as Pool;
    },
    // Admin is nested beneath the proxied store, so its SQL functions bind ownership explicitly.
    query: <TRow extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []) =>
      runWithStore(runtime, () => postgresQuery<TRow>(text, values)),
    transaction: <TResult>(operation: (client: PoolClient) => Promise<TResult>) =>
      runWithStore(runtime, () => withPostgresTransaction(operation)),
  });
  return storeProxy(runtime, {
    ...repos,
    ...engineRepos,
    ...telegramRepos,
    settings: runtime.settings,
    admin,
    ready: () => persistenceReady(),
    close: () => closeStoreRuntime(runtime),
    withAdvisoryLock: (key, operation) => withPostgresAdvisoryLock(key, operation),
    tryAcquireSingletonLock: (key) => tryAcquireSingletonLock(runtime, key),
  });
}

export function createStore(options: StoreOptions): Store {
  return buildStore(createStoreRuntime(options));
}

/** Internal construction seam for deterministic factory/client tests; not re-exported from the package root. */
export function createStoreWithDependencies(
  options: StoreOptions,
  dependencies: StoreRuntimeDependencies,
): Store {
  return buildStore(createStoreRuntime(options, dependencies));
}
