import { Hono } from 'hono';
import { config } from './config.ts';
import { runCycleInWorker, stopJobWorker } from './worker-client.ts';
import { initializeSchedules, runScheduledCycle } from './vacancies/jobs.ts';
import {
  handleTelegramWebhookUpdate, initializeTelegramWebhookMode, sendDailyDigest, sendPendingAlerts, startTelegramBot, stopTelegramBot,
} from './telegram.ts';
import { errorMessage } from './observability.ts';
import { persistenceReady } from './postgres.ts';
import { enqueueTelegramUpdateTask } from './cloud-tasks.ts';
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate } from './telegram-state.ts';

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
app.get('/ready',async(c)=> {
  try { return c.json({ ok:true,persistence:await persistenceReady() }); }
  catch(error) { console.error(`Readiness check failed: ${errorMessage(error)}`); return c.json({ ok:false },503); }
});
app.post('/telegram/webhook', async (c) => {
  if (config.telegramMode !== 'webhook') return c.json({ ok: false }, 404);
  const secret = config.telegramWebhookSecret;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    console.error('TELEGRAM_WEBHOOK_SECRET must contain 32-256 URL-safe characters.');
    return c.json({ ok: false }, 503);
  }
  if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== secret) return c.json({ ok: false }, 401);
  let update: unknown;
  try { update = await c.req.json(); }
  catch { return c.json({ ok: false }, 400); }
  const updateId = Number((update as { update_id?: unknown })?.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0) return c.json({ ok: false }, 400);
  if (config.telegramWebhookAsync) {
    try {
      const created=await enqueueTelegramUpdateTask(update,updateId);
      return c.json({ ok:true,queued:true,duplicate:!created });
    } catch(error) {
      console.error(`Telegram webhook enqueue failed: ${errorMessage(error)}`);
      return c.json({ ok:false },500);
    }
  }
  if (!await claimTelegramUpdate(updateId)) return c.json({ ok: true, duplicate: true });
  try {
    await handleTelegramWebhookUpdate(update);
    await completeTelegramUpdate(updateId);
    return c.json({ ok: true });
  } catch (error) {
    await failTelegramUpdate(updateId, error).catch(() => undefined);
    console.error(`Telegram webhook update failed: ${errorMessage(error)}`);
    return c.json({ ok: false }, 500);
  }
});

initializeSchedules(runCycleInWorker, sendPendingAlerts, sendDailyDigest);

startTelegramBot();
void initializeTelegramWebhookMode().catch((error) =>
  console.error(`Telegram webhook initialization failed: ${errorMessage(error)}`));

if (config.runJobs && config.runInitialCycle) {
  // Do not wait until the next unified cycle after a restart.
  setTimeout(() => void runScheduledCycle().catch((error) =>
    console.error(`Initial cycle failed: ${errorMessage(error)}`)), 2_000);
}



import { serve } from '@hono/node-server';
import { closePostgresPool } from './postgres.ts';

const port=Number(process.env.PORT??3000);
if(!Number.isSafeInteger(port)||port<1||port>65_535)throw new Error('PORT must be an integer between 1 and 65535.');
const server=serve({fetch:app.fetch,port});
let stopping=false;
async function stop():Promise<void>{if(stopping)return;stopping=true;
  await stopTelegramBot();await stopJobWorker();
  await new Promise<void>(resolve=>server.close(()=>resolve()));await closePostgresPool();}
process.once('SIGTERM',()=>void stop());
process.once('SIGINT',()=>void stop());
