import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundTaskRetryDelayMs } from '../src/lib/background-tasks.ts';
import { BackgroundTaskWorker } from '../src/lib/background-task-worker.ts';
import { claimCoordinationLease,releaseCoordinationLease,withRenewingCoordinationLease } from '../src/lib/coordination-leases.ts';

test('background task retries use capped exponential backoff', () => {
  assert.equal(backgroundTaskRetryDelayMs(1),5_000);
  assert.equal(backgroundTaskRetryDelayMs(2),10_000);
  assert.equal(backgroundTaskRetryDelayMs(5),80_000);
  assert.equal(backgroundTaskRetryDelayMs(25),24*60*60_000);
  assert.throws(()=>backgroundTaskRetryDelayMs(0),/positive integer/);
});

test('background task workers enforce bounded execution settings', () => {
  const handlers={ example: async () => undefined };
  assert.throws(()=>new BackgroundTaskWorker({ workerId:'',handlers }),/workerId/);
  assert.throws(()=>new BackgroundTaskWorker({ workerId:'test',handlers:{},concurrency:1 }),/handler/);
  assert.throws(()=>new BackgroundTaskWorker({ workerId:'test',handlers,concurrency:21 }),/concurrency/);
  assert.throws(()=>new BackgroundTaskWorker({ workerId:'test',handlers,leaseMs:1_000 }),/leaseMs/);
});

test('coordination leases serialize owners and release after guarded work',async()=> {
  const key=`unit:${Date.now()}:${Math.random()}`;
  assert.equal(await claimCoordinationLease(key,'owner-a',5_000),true);
  assert.equal(await claimCoordinationLease(key,'owner-b',5_000),false);
  await releaseCoordinationLease(key,'owner-a');
  const result=await withRenewingCoordinationLease({ resourceKey:key,owner:'owner-b',leaseMs:5_000,renewEveryMs:1_000 },
    async()=>42);
  assert.deepEqual(result,{ acquired:true,result:42 });
  assert.equal(await claimCoordinationLease(key,'owner-c',5_000),true);
  await releaseCoordinationLease(key,'owner-c');
});
