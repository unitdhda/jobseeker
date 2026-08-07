import * as repositories from './repos.ts';
import * as engineRepositories from './engine-repos.ts';
import * as telegramRepositories from './telegram-repos.ts';
import {
  closeStoreRuntime, createStoreRuntime, getPostgresPool, persistenceReady, postgresQuery, runWithStore,
  tryAcquireSingletonLock, withPostgresAdvisoryLock, withPostgresTransaction, type StoreOptions, type StoreRuntime,
} from './client.ts';

function bindModule<T extends object>(owner: StoreRuntime, module: T): T {
  return new Proxy(module, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runWithStore(owner,
        () => (value as (...parameters: unknown[]) => unknown)(...args));
    },
  });
}

/** Creates one isolated PostgreSQL store. No pool or settings are shared between instances. */
export function createStore(options: StoreOptions) {
  const owner = createStoreRuntime(options);
  const repos = bindModule(owner, repositories);
  const engine = bindModule(owner, engineRepositories);
  const telegram = bindModule(owner, telegramRepositories);
  return {
    settings:options.settings,
    ...repos,
    ...engine,
    ...telegram,
    persistenceReady: () => runWithStore(owner, persistenceReady),
    withPostgresAdvisoryLock: <T>(key: string, operation: () => Promise<T>) =>
      runWithStore(owner, () => withPostgresAdvisoryLock(key, operation)),
    tryAcquireSingletonLock: (key: string) => tryAcquireSingletonLock(owner, key),
    closePostgresPool: () => closeStoreRuntime(owner),
    admin: {
      getPostgresPool: () => runWithStore(owner, getPostgresPool),
      postgresQuery: <T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string,
        parameters: unknown[] = []) => runWithStore(owner, () => postgresQuery<T>(text, parameters)),
      withPostgresTransaction: <T>(operation: Parameters<typeof withPostgresTransaction<T>>[0]) =>
        runWithStore(owner, () => withPostgresTransaction(operation)),
    },
  };
}

export type Store = ReturnType<typeof createStore>;
