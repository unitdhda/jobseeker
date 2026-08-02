import { hasPostgresDatabase,postgresQuery } from './postgres.ts';

const localLeases=new Map<string,{ owner:string; expiresAt:number }>();
function text(name:string,value:string,maximum:number): string {
  const normalized=value.trim();
  if (!normalized||normalized.length>maximum||/[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${name} must contain 1-${maximum} printable characters.`);
  }
  return normalized;
}
function duration(value:number): number {
  if (!Number.isSafeInteger(value)||value<1_000||value>60*60_000) throw new Error('leaseMs must be between 1000 and 3600000.');
  return value;
}

export async function claimCoordinationLease(resourceKey:string,owner:string,leaseMs:number): Promise<boolean> {
  const resource=text('resourceKey',resourceKey,300); const leaseOwner=text('owner',owner,220); const milliseconds=duration(leaseMs);
  const expiresAt=new Date(Date.now()+milliseconds);
  if (!hasPostgresDatabase()) {
    const current=localLeases.get(resource);
    if (current&&current.expiresAt>Date.now()&&current.owner!==leaseOwner) return false;
    localLeases.set(resource,{ owner:leaseOwner,expiresAt:expiresAt.getTime() }); return true;
  }
  const rows=await postgresQuery(`insert into coordination_leases(resource_key,lease_owner,lease_expires_at,updated_at)
    values($1,$2,$3,now()) on conflict(resource_key) do update set lease_owner=excluded.lease_owner,
    lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at where coordination_leases.lease_expires_at<=now()
    or coordination_leases.lease_owner=excluded.lease_owner returning resource_key`,[resource,leaseOwner,expiresAt]);
  return Boolean(rows.length);
}

export async function renewCoordinationLease(resourceKey:string,owner:string,leaseMs:number): Promise<Date> {
  const resource=text('resourceKey',resourceKey,300); const leaseOwner=text('owner',owner,220); const milliseconds=duration(leaseMs);
  const expiresAt=new Date(Date.now()+milliseconds);
  if (!hasPostgresDatabase()) {
    const current=localLeases.get(resource);
    if (!current||current.owner!==leaseOwner||current.expiresAt<=Date.now()) throw new Error('Coordination lease was lost.');
    current.expiresAt=expiresAt.getTime(); return expiresAt;
  }
  const rows=await postgresQuery(`update coordination_leases set lease_expires_at=$3,updated_at=now()
    where resource_key=$1 and lease_owner=$2 and lease_expires_at>now() returning resource_key`,[resource,leaseOwner,expiresAt]);
  if (!rows.length) throw new Error('Coordination lease was lost.');
  return expiresAt;
}

export async function releaseCoordinationLease(resourceKey:string,owner:string): Promise<void> {
  const resource=text('resourceKey',resourceKey,300); const leaseOwner=text('owner',owner,220);
  if (!hasPostgresDatabase()) {
    if (localLeases.get(resource)?.owner===leaseOwner) localLeases.delete(resource); return;
  }
  await postgresQuery('delete from coordination_leases where resource_key=$1 and lease_owner=$2',[resource,leaseOwner]);
}

export async function withRenewingCoordinationLease<T>(options:{ resourceKey:string; owner:string; leaseMs:number;
  renewEveryMs?:number },handler:(signal:AbortSignal)=>Promise<T>): Promise<{ acquired:boolean; result?:T }> {
  const renewEvery=options.renewEveryMs??Math.floor(options.leaseMs/3);
  if (!Number.isSafeInteger(renewEvery)||renewEvery<500||renewEvery>=options.leaseMs) {
    throw new Error('renewEveryMs must be at least 500 and lower than leaseMs.');
  }
  if (!await claimCoordinationLease(options.resourceKey,options.owner,options.leaseMs)) return { acquired:false };
  const controller=new AbortController(); let timer:NodeJS.Timeout|undefined; let heartbeat:Promise<void>|undefined;
  let leaseFailure:unknown;
  const schedule=():void=> {
    timer=setTimeout(()=> {
      heartbeat=(async()=> {
        try { await renewCoordinationLease(options.resourceKey,options.owner,options.leaseMs); }
        catch(error) { leaseFailure=error; controller.abort(error); }
        if (!leaseFailure&&!controller.signal.aborted) schedule();
      })();
    },renewEvery);
  };
  schedule();
  try {
    const result=await handler(controller.signal);
    if (timer) clearTimeout(timer); await heartbeat;
    if (leaseFailure) throw leaseFailure;
    return { acquired:true,result };
  } finally {
    controller.abort(); if (timer) clearTimeout(timer); await heartbeat;
    await releaseCoordinationLease(options.resourceKey,options.owner).catch(()=>undefined);
  }
}
