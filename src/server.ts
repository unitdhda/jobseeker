import { serve } from '@hono/node-server';
import app from './app.ts';
import { closePostgresPool } from './lib/postgres.ts';

const port=Number(process.env.PORT??3000);
if(!Number.isSafeInteger(port)||port<1||port>65_535)throw new Error('PORT must be an integer between 1 and 65535.');
const server=serve({fetch:app.fetch,port});
let stopping=false;
async function stop():Promise<void>{if(stopping)return;stopping=true;
  await new Promise<void>(resolve=>server.close(()=>resolve()));await closePostgresPool();}
process.once('SIGTERM',()=>void stop());
process.once('SIGINT',()=>void stop());
