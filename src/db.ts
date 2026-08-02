import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { postgres } from '@flue/postgres';
import { sqlite } from '@flue/runtime/node';
import { config } from './config.ts';
import {
  closePostgresPool, getPostgresPool, hasPostgresDatabase, withPostgresTransaction,
} from './lib/postgres.ts';

process.umask(0o077);

const database = hasPostgresDatabase() ? postgres({
  query: async (text, params) => (await getPostgresPool().query(text, params)).rows,
  transaction: (fn) => withPostgresTransaction((client) => fn({
    query: async (text, params) => (await client.query(text, params)).rows,
  })),
  close: closePostgresPool,
}) : (() => {
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(config.databasePath), 0o700);
  const adapter = sqlite(config.databasePath);
  chmodSync(config.databasePath, 0o600);
  return adapter;
})();

export default database;
