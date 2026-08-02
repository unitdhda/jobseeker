import { hasPostgresDatabase,postgresQuery } from './postgres.ts';

export async function persistenceReady(): Promise<'postgres'|'sqlite'> {
  if (!hasPostgresDatabase()) return 'sqlite';
  await postgresQuery('select 1');
  return 'postgres';
}
