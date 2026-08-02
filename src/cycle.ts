import { runSingletonScrapeCycle } from './vacancies/jobs.ts';
import { persistHhBrowserState, restoreHhBrowserState } from './runtime-state.ts';
import { enqueueDueDeliveryTasks } from './cloud-tasks.ts';
import { config } from './config.ts';

await restoreHhBrowserState();
try {
  const result=await runSingletonScrapeCycle();
  if (result&&config.backgroundDeliveryAsync) {
    const queued=await enqueueDueDeliveryTasks();
    console.info(`Queued ${queued} delivery tasks.`);
  }
} finally {
  await persistHhBrowserState().catch((error) =>
    console.error(`Could not persist HH browser state: ${error instanceof Error ? error.message : String(error)}`));
}
process.exit(0);
