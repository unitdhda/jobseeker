// The store composition must run before any module touches a repository.
import './postgres.ts';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeCloudTasksClient, enqueueTelegramUpdateTask } from './cloud-tasks.ts';
import { config } from './config.ts';
import { errorMessage } from './observability.ts';
import {
  claimTelegramUpdate, closePostgresPool, completeTelegramUpdate, failTelegramUpdate, persistenceReady,
} from './postgres.ts';

const app=new Hono();
app.get('/health',c=>c.json({ok:true}));
app.get('/ready',async c=>{
  try{return c.json({ok:true,persistence:await persistenceReady()});}
  catch(error){console.error(`Readiness check failed: ${errorMessage(error)}`);return c.json({ok:false},503);}
});
app.post('/telegram/webhook',async c=>{
  if(config.telegramMode!=='webhook')return c.json({ok:false},404);
  const secret=config.telegramWebhookSecret;
  if(!secret||!/^[-A-Za-z0-9_]{32,256}$/.test(secret)){
    console.error('TELEGRAM_WEBHOOK_SECRET must contain 32-256 URL-safe characters.');return c.json({ok:false},503);
  }
  if(c.req.header('X-Telegram-Bot-Api-Secret-Token')!==secret)return c.json({ok:false},401);
  let update:unknown;try{update=await c.req.json();}catch{return c.json({ok:false},400);}
  const updateId=Number((update as {update_id?:unknown})?.update_id);
  if(!Number.isSafeInteger(updateId)||updateId<0)return c.json({ok:false},400);
  if(config.telegramWebhookAsync){
    try{const created=await enqueueTelegramUpdateTask(update,updateId);return c.json({ok:true,queued:true,duplicate:!created});}
    catch(error){console.error(`Telegram webhook enqueue failed: ${errorMessage(error)}`);return c.json({ok:false},500);}
  }
  if(!await claimTelegramUpdate(updateId))return c.json({ok:true,duplicate:true});
  try{
    const {handleTelegramWebhookUpdate}=await import('./telegram/bot.ts');
    await handleTelegramWebhookUpdate(update);await completeTelegramUpdate(updateId);return c.json({ok:true});
  }catch(error){
    await failTelegramUpdate(updateId,error).catch(()=>undefined);
    console.error(`Telegram webhook update failed: ${errorMessage(error)}`);return c.json({ok:false},500);
  }
});

let stopRuntime=async():Promise<void>=>{};
async function initializeRuntime():Promise<void>{
  if(!config.runJobs&&config.telegramMode!=='polling'&&!(config.telegramMode==='webhook'&&!config.telegramWebhookAsync))return;
  const [telegram,worker,engine]=await Promise.all([import('./telegram/bot.ts'),import('./worker-client.ts'),import('./engine-main.ts')]);
  telegram.startTelegramBot();
  if(config.telegramMode==='webhook')await telegram.initializeTelegramWebhookMode();
  if(config.runJobs)engine.startEngineLoop();
  stopRuntime=async()=>{await engine.stopEngineLoop();await telegram.stopTelegramBot();await worker.stopJobWorker();};
}
await initializeRuntime();

const port=Number(process.env.PORT??3000);
if(!Number.isSafeInteger(port)||port<1||port>65_535)throw new Error('PORT must be an integer between 1 and 65535.');
const server=serve({fetch:app.fetch,port});let stopping=false;
async function stop():Promise<void>{
  if(stopping)return;stopping=true;await stopRuntime();await closeCloudTasksClient();
  await new Promise<void>(resolve=>server.close(()=>resolve()));await closePostgresPool();
}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
