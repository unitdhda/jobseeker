import { runScrapeCycle } from '../lib/jobs.ts';
import { startScriptRuntime } from './runtime.ts';
import { persistHhBrowserState, restoreHhBrowserState } from '../lib/browser-state.ts';

await restoreHhBrowserState();
const flue = await startScriptRuntime();
try {
  await runScrapeCycle();
} finally {
  await persistHhBrowserState().catch((error) =>
    console.error(`Could not persist HH browser state: ${error instanceof Error ? error.message : String(error)}`));
  await Promise.race([flue.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}
process.exit(0);
