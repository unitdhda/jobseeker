import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { BackgroundTaskWorker } from './lib/background-task-worker.ts';
import { getBackgroundTask } from './lib/background-tasks.ts';
import { telegramUpdateTaskKind,handleTelegramUpdateTask } from './lib/telegram-background-task.ts';
import {
  alertDeliveryTaskKind,digestDeliveryTaskKind,handleAlertDeliveryTask,handleDigestDeliveryTask,
} from './lib/delivery-background-tasks.ts';
import { errorMessage } from './lib/logging.ts';
import { persistenceReady } from './lib/readiness.ts';

const workerId=process.env.K_REVISION?.trim()||process.env.HOSTNAME?.trim()||`task-worker-${process.pid}`;
const executionSecret=process.env.TASK_EXECUTION_SECRET?.trim()??'';
if (!/^[A-Za-z0-9_-]{32,256}$/.test(executionSecret)) {
  throw new Error('TASK_EXECUTION_SECRET must contain 32-256 URL-safe characters.');
}
const worker=new BackgroundTaskWorker({ workerId,handlers:{
  [telegramUpdateTaskKind]:handleTelegramUpdateTask,
  [alertDeliveryTaskKind]:handleAlertDeliveryTask,
  [digestDeliveryTaskKind]:handleDigestDeliveryTask,
},leaseMs:Number(process.env.BACKGROUND_TASK_LEASE_MS??300_000) });
const app=new Hono();

function authorized(provided: string|undefined): boolean {
  if (!provided) return false;
  const a=Buffer.from(executionSecret); const b=Buffer.from(provided);
  return a.length===b.length&&timingSafeEqual(a,b);
}

app.get('/health',(c)=>c.json({ ok:true }));
app.get('/ready',async(c)=> {
  try { return c.json({ ok:true,persistence:await persistenceReady() }); }
  catch(error) { console.error(`Worker readiness check failed: ${errorMessage(error)}`); return c.json({ ok:false },503); }
});
app.post('/tasks/execute',async(c)=> {
  if (!authorized(c.req.header('X-Task-Execution-Secret'))) return c.json({ ok:false },401);
  let body: unknown;
  try { body=await c.req.json(); } catch { return c.json({ ok:false },400); }
  const taskKey=(body as { taskKey?: unknown }|null)?.taskKey;
  if (typeof taskKey!=='string'||!taskKey||taskKey.length>240) return c.json({ ok:false },400);
  try {
    const outcome=await worker.runTask(taskKey);
    if (outcome==='completed'||outcome==='failed') return c.json({ ok:true,outcome });
    if (outcome==='retrying'||outcome==='lease-lost') {
      c.header('Retry-After','5'); return c.json({ ok:false,outcome },503);
    }
    const task=await getBackgroundTask(taskKey);
    if (!task||['completed','failed','cancelled'].includes(task.state)) return c.json({ ok:true,outcome:task?.state??'missing' });
    c.header('Retry-After','5'); return c.json({ ok:false,outcome:'not-ready' },503);
  } catch(error) {
    console.error(`Task execution request failed: ${errorMessage(error)}`);
    c.header('Retry-After','5'); return c.json({ ok:false },503);
  }
});

export default app;
