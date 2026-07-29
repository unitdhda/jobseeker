import { runScrapeCycle } from '../lib/jobs.ts';
import { startScriptRuntime } from './runtime.ts';

const flue = await startScriptRuntime();
try {
  await runScrapeCycle();
} finally {
  await Promise.race([flue.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}
process.exit(0);
