import { Hono } from 'hono';
import { config } from './config.ts';
import { runCycleInWorker } from './lib/job-worker-client.ts';
import { initializeSchedules, runScheduledCycle } from './lib/schedules.ts';
import { sendDailyDigest, sendPendingAlerts, startTelegramBot } from './lib/telegram.ts';
import { errorMessage } from './lib/logging.ts';

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));

initializeSchedules(runCycleInWorker, sendPendingAlerts, sendDailyDigest);

startTelegramBot();

if (config.runJobs && config.runInitialCycle) {
  // Do not wait until the next unified cycle after a restart.
  setTimeout(() => void runScheduledCycle().catch((error) =>
    console.error(`Initial cycle failed: ${errorMessage(error)}`)), 2_000);
}

export default app;
