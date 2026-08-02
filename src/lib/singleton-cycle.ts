import { runScrapeCycle, type ScrapeCycleResult, type UserTaskRunner } from './jobs.ts';
import { getPostgresPool } from './postgres.ts';

export async function runSingletonScrapeCycle(runUserTask?: UserTaskRunner): Promise<ScrapeCycleResult | null> {
  const client = await getPostgresPool().connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('jobseeker-cycle')) acquired",
    );
    acquired = Boolean(result.rows[0]?.acquired);
    if (!acquired) {
      console.info('Skipping scrape cycle because another cycle holds the PostgreSQL advisory lock.');
      return null;
    }
    return await runScrapeCycle(runUserTask);
  } finally {
    if (acquired) await client.query("select pg_advisory_unlock(hashtext('jobseeker-cycle'))").catch(() => undefined);
    client.release();
  }
}
