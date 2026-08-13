import type { QueryResultRow } from 'pg';

export interface StoreAdminClient {
  connect(): Promise<void>;
  query<TRow extends QueryResultRow = QueryResultRow>(statement: string): Promise<{ readonly rows: TRow[] }>;
  end(): Promise<void>;
}

const tableCountStatement = `select count(*) total from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE'`;

/** Fresh-install operation only: the whole schema is one transaction and public must be empty. */
export async function initializeEmptyPublicSchema(client: StoreAdminClient, schema: string): Promise<number> {
  if (!schema.trim()) throw new TypeError('Database schema is empty.');
  await client.connect();
  try {
    const existing = await client.query<{ total: string }>(tableCountStatement);
    if (Number(existing.rows[0]?.total ?? 0) !== 0) throw new Error('Database public schema is not empty.');
    await client.query('begin');
    try { await client.query(schema); await client.query('commit'); }
    catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
    const created = await client.query<{ total: string }>(tableCountStatement);
    return Number(created.rows[0]?.total ?? 0);
  } finally { await client.end(); }
}

/** Readiness owns its SQL in the persistence package and always releases the one-shot client. */
export async function publicUsersTableReady(client: StoreAdminClient): Promise<boolean> {
  await client.connect();
  try {
    const result = await client.query<{ ready: boolean }>(`select to_regclass('public.users') is not null ready`);
    return result.rows[0]?.ready === true;
  } finally { await client.end(); }
}
