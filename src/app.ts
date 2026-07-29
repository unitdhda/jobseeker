import { Hono } from 'hono';
import { config } from './config.ts';
import { runCycleInWorker } from './lib/job-worker-client.ts';
import { initializeSchedules } from './lib/schedules.ts';
import { sendDailyDigest, sendPendingAlerts, startTelegramBot } from './lib/telegram.ts';
import { errorMessage } from './lib/logging.ts';

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));

initializeSchedules(runCycleInWorker, sendPendingAlerts, sendDailyDigest);

startTelegramBot();

if (config.runJobs && config.runInitialCycle) {
  // Do not wait until the next notification schedule after a restart.
  setTimeout(() => void runCycleInWorker().catch((error) =>
    console.error(`Initial scrape failed: ${errorMessage(error)}`)), 2_000);
}

export default app;
