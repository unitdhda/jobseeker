import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConfig, QueryResult, QueryResultRow } from 'pg';
import type { StoreOptions, StoreRuntimeDependencies } from '../src/client.ts';
import { createStoreWithDependencies } from '../src/store.ts';

function result<TRow extends QueryResultRow>(rows: TRow[] = []): QueryResult<TRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function options(owner: string, databaseUrl = 'postgres://private.invalid/database'): StoreOptions {
  return {
    databaseUrl,
    poolMax: 3,
    ssl: false,
    settings: {
      telegramUserId: owner,
      accessRequestCooldownMinutes: 60,
      prefilterMaxAgeDays: 30,
      searchPlatforms: ['example'],
      digestMinScore: 60,
      alertScore: 80,
      timezone: 'UTC',
      safeVacancyUrl: (_source, url) => url,
    },
  };
}

test('stores retain independent settings and create no pool eagerly', async () => {
  const configs: PoolConfig[] = [];
  let ended = 0;
  const dependencies: StoreRuntimeDependencies = {
    createPool(config) {
      configs.push(config);
      return {
        query: async <TRow extends QueryResultRow>() => result<TRow>(),
        connect: async () => ({ query: async <TRow extends QueryResultRow>() => result<TRow>(), release: () => undefined }),
        end: async () => { ended += 1; },
      };
    },
    createClient: () => ({ connect: async () => undefined, query: async <TRow extends QueryResultRow>() => result<TRow>(), end: async () => undefined }),
    sleep: async () => undefined,
  };
  const first = createStoreWithDependencies(options('1'), dependencies);
  const second = createStoreWithDependencies(options('2'), dependencies);
  assert.equal(configs.length, 0);
  assert.equal(first.settings.telegramUserId, '1');
  assert.equal(second.settings.telegramUserId, '2');
  assert.notEqual(first.settings, second.settings);

  void first.admin.pool;
  assert.equal(configs.length, 1);
  assert.equal(configs[0]!.max, 3);
  assert.equal(configs[0]!.connectionString, 'postgres://private.invalid/database');
  await first.close();
  await first.close();
  assert.equal(ended, 1);
  assert.equal(configs.length, 1);
});

test('repository ownership survives promises and does not leak between stores', async () => {
  const seen: string[] = [];
  const dependencies: StoreRuntimeDependencies = {
    createPool(config) {
      return {
        query: async <TRow extends QueryResultRow>() => {
          await Promise.resolve();
          seen.push(String(config.connectionString));
          return result<TRow>();
        },
        connect: async () => ({ query: async <TRow extends QueryResultRow>() => result<TRow>(), release: () => undefined }),
        end: async () => undefined,
      };
    },
    createClient: () => ({ connect: async () => undefined, query: async <TRow extends QueryResultRow>() => result<TRow>(), end: async () => undefined }),
    sleep: async () => undefined,
  };
  const first = createStoreWithDependencies(options('1', 'postgres://first.invalid/db'), dependencies);
  const second = createStoreWithDependencies(options('2', 'postgres://second.invalid/db'), dependencies);
  await Promise.all([first.admin.query('select 1'), second.admin.query('select 1')]);
  assert.deepEqual(seen.sort(), ['postgres://first.invalid/db', 'postgres://second.invalid/db']);
});

test('transient query failures retry twice with bounded exponential delay and redacted errors', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const dependencies: StoreRuntimeDependencies = {
    createPool: () => ({
      query: async () => { attempts += 1; throw Object.assign(new Error('server leaked private URL'), { code: 'ECONNRESET' }); },
      connect: async () => { throw new Error('unused'); },
      end: async () => undefined,
    }),
    createClient: () => ({ connect: async () => undefined, query: async <TRow extends QueryResultRow>() => result<TRow>(), end: async () => undefined }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  };
  const store = createStoreWithDependencies(options('1'), dependencies);
  await assert.rejects(store.admin.query('select secret', ['private']), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /PostgreSQL query failed \(ECONNRESET\)/u);
    assert.doesNotMatch(error.message, /private|secret|server leaked/u);
    return true;
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [50, 100]);
});
