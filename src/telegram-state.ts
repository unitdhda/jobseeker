import { postgresQuery, withPostgresTransaction } from './postgres.ts';

function validKind(kind:string):void{
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(kind))throw new Error('Telegram session kind is invalid.');
}
function expiry(ttlMs:number):Date{
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1_000||ttlMs>30*86_400_000)throw new Error('Telegram session TTL is invalid.');
  return new Date(Date.now()+ttlMs);
}
export async function getTelegramSession<T>(userId:string,kind:string):Promise<T|null>{
  validKind(kind);const rows=await postgresQuery<{state:T}>(`select state from user_state
    where user_id=$1 and kind=$2 and expires_at>now()`,[userId,kind]);return rows[0]?.state??null;
}
export async function setTelegramSession(userId:string,kind:string,state:unknown,ttlMs:number):Promise<void>{
  validKind(kind);await postgresQuery(`insert into user_state(user_id,kind,state,expires_at,updated_at) values($1,$2,$3::jsonb,$4,now())
    on conflict(user_id,kind) do update set state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    [userId,kind,JSON.stringify(state),expiry(ttlMs)]);
}
export async function claimTelegramSession(userId:string,kind:string,state:unknown,ttlMs:number):Promise<{claimed:boolean;expiresAt:Date}>{
  validKind(kind);const expiresAt=expiry(ttlMs);const rows=await postgresQuery<{expires_at:Date}>(`insert into user_state(user_id,kind,state,expires_at,updated_at)
    values($1,$2,$3::jsonb,$4,now()) on conflict(user_id,kind) do update set state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    where user_state.expires_at<=now() returning expires_at`,[userId,kind,JSON.stringify(state),expiresAt]);
  if(rows[0])return{claimed:true,expiresAt:new Date(rows[0].expires_at)};
  const current=await postgresQuery<{expires_at:Date}>('select expires_at from user_state where user_id=$1 and kind=$2',[userId,kind]);
  return{claimed:false,expiresAt:new Date(current[0]!.expires_at)};
}
export async function deleteTelegramSession(userId:string,kind:string):Promise<void>{
  validKind(kind);await postgresQuery('delete from user_state where user_id=$1 and kind=$2',[userId,kind]);
}

let lastCleanup=0;
export async function claimTelegramUpdate(updateId:number,retryProcessing=false):Promise<boolean>{
  if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Telegram update_id is invalid.');
  const claimed=await withPostgresTransaction(async client=>{
    const inserted=await client.query(`insert into telegram_updates(update_id,state,attempts,lease_expires_at)
      values($1,'processing',1,now()+interval '5 minutes') on conflict(update_id) do nothing returning update_id`,[updateId]);
    if(inserted.rowCount)return true;
    const retried=await client.query(`update telegram_updates set state='processing',attempts=attempts+1,
      lease_expires_at=now()+interval '5 minutes',last_error=null where update_id=$1
      and (state='failed' or (state='processing' and (lease_expires_at<now() or $2))) returning update_id`,[updateId,retryProcessing]);
    return Boolean(retried.rowCount);
  });
  if(Date.now()-lastCleanup>3_600_000){lastCleanup=Date.now();void postgresQuery("delete from telegram_updates where received_at<now()-interval '7 days'").catch(()=>undefined);}
  return claimed;
}
export async function completeTelegramUpdate(updateId:number):Promise<void>{
  await postgresQuery(`update telegram_updates set state='completed',completed_at=now(),lease_expires_at=null,last_error=null where update_id=$1`,[updateId]);
}
export async function failTelegramUpdate(updateId:number,error:unknown):Promise<void>{
  const failureType=error instanceof Error?error.name:'UnknownError';
  await postgresQuery(`update telegram_updates set state='failed',lease_expires_at=null,last_error=$2 where update_id=$1`,[updateId,failureType.slice(0,120)]);
}
