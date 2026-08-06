// The store composition must run before any module touches a repository.
import './postgres.ts';
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { handleCloudTask, type CloudTaskRequest } from './cloud-tasks.ts';
import { errorMessage } from './observability.ts';
import { persistenceReady } from './postgres.ts';

const executionSecret = process.env.TASK_EXECUTION_SECRET?.trim() ?? '';
if (!/^[A-Za-z0-9_-]{32,256}$/.test(executionSecret)) throw new Error('TASK_EXECUTION_SECRET is invalid.');

function authorized(provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = Buffer.from(executionSecret);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
app.get('/ready', async (c) => {
  try { return c.json({ ok: true, persistence: await persistenceReady() }); }
  catch (error) {
    console.error(`Worker readiness check failed: ${errorMessage(error)}`);
    return c.json({ ok: false }, 503);
  }
});
app.post('/tasks/execute', async (c) => {
  if (!authorized(c.req.header('X-Task-Execution-Secret'))) return c.json({ ok: false }, 401);
  let request: CloudTaskRequest;
  try { request = await c.req.json<CloudTaskRequest>(); }
  catch { return c.json({ ok: false }, 400); }
  try {
    await handleCloudTask(request);
    return c.json({ ok: true });
  } catch (error) {
    console.error(`Cloud Task failed: ${errorMessage(error)}`);
    return c.json({ ok: false }, 500);
  }
});



import { serve } from '@hono/node-server';
import { closePostgresPool } from './postgres.ts';
import { initializeTelegramWebhookMode } from './telegram/bot.ts';

await initializeTelegramWebhookMode();
const port=Number(process.env.PORT??3000);
if (!Number.isSafeInteger(port)||port<1||port>65_535) throw new Error('PORT must be an integer between 1 and 65535.');
const server=serve({ fetch:app.fetch,port });
let stopping=false;
async function stop(): Promise<void> {
  if (stopping) return; stopping=true;
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
  await closePostgresPool();
}
process.once('SIGTERM',()=>void stop());
process.once('SIGINT',()=>void stop());
