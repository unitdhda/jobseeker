import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { handleCloudTask, type CloudTaskRequest } from './lib/cloud-tasks.ts';
import { errorMessage } from './lib/logging.ts';
import { persistenceReady } from './lib/readiness.ts';

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

export default app;
