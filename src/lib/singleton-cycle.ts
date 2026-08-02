import { randomUUID } from 'node:crypto';
import { runScrapeCycle,type ScrapeCycleResult,type UserTaskRunner } from './jobs.ts';
import { withRenewingCoordinationLease } from './coordination-leases.ts';

export async function runSingletonScrapeCycle(runUserTask?:UserTaskRunner): Promise<ScrapeCycleResult|null> {
  const owner=`${process.env.K_REVISION?.trim()||process.env.HOSTNAME?.trim()||process.pid}:${randomUUID()}`;
  const execution=await withRenewingCoordinationLease({ resourceKey:'cycle:global',owner,leaseMs:5*60_000,
    renewEveryMs:60_000 },async(signal)=> {
    if (signal.aborted) throw new Error('Cycle lease was lost before execution.');
    const result=await runScrapeCycle(runUserTask);
    if (signal.aborted) throw new Error('Cycle lease was lost during execution.');
    return result;
  });
  if (!execution.acquired) {
    console.info('Skipping scrape cycle because another cycle owns the global lease.');
    return null;
  }
  return execution.result!;
}
