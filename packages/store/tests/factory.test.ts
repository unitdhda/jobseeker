import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, type StoreSettings } from '../src/index.ts';

const settings=(timezone:string):StoreSettings=>({accessRequestCooldownMinutes:1,prefilterMaxAgeDays:30,
  searchPlatforms:[],digestMinScore:50,alertScore:80,timezone,safeVacancyUrl:(_source,url)=>url});

test('store factories own independent settings and lazy pools',async()=>{
  const first=createStore({databaseUrl:'',poolMax:1,ssl:false,settings:settings('UTC')});
  const second=createStore({databaseUrl:'',poolMax:2,ssl:false,settings:settings('+03:00')});
  assert.equal(first.settings.timezone,'UTC');
  assert.equal(second.settings.timezone,'+03:00');
  await assert.rejects(first.persistenceReady(),/DATABASE_URL/);
  await assert.rejects(second.persistenceReady(),/DATABASE_URL/);
  await Promise.all([first.closePostgresPool(),second.closePostgresPool()]);
});
