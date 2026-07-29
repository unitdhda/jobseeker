import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sqlite } from '@flue/runtime/node';
import { config } from './config.ts';

process.umask(0o077);
mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
chmodSync(dirname(config.databasePath), 0o700);

// Flue and the application use different tables in this one local SQLite file.
const database = sqlite(config.databasePath);
chmodSync(config.databasePath, 0o600);
export default database;
