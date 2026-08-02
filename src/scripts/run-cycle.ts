import { runSingletonScrapeCycle } from '../lib/singleton-cycle.ts';
import { startScriptRuntime } from './runtime.ts';
import { persistHhBrowserState, restoreHhBrowserState } from '../lib/browser-state.ts';
import { enqueueDueDeliveryTasks } from '../lib/cloud-tasks.ts';
import { config } from '../config.ts';

await restoreHhBrowserState();
const flue = await startScriptRuntime();
try {
  const result=await runSingletonScrapeCycle();
  if (result&&config.backgroundDeliveryAsync) {
    const queued=await enqueueDueDeliveryTasks();
    console.info(`Queued ${queued} delivery tasks.`);
  }
} finally {
  await persistHhBrowserState().catch((error) =>
    console.error(`Could not persist HH browser state: ${error instanceof Error ? error.message : String(error)}`));
  await Promise.race([flue.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}
process.exit(0);
