import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceRegistry, type SourcesOptions } from '../src/index.ts';

function options(area:string):SourcesOptions{return{
  settings:{searchNewVacancyLimit:1,searchPageBudgetPerPlatform:3,hhMaxPages:1,hhAreaId:area,
    hhBrowserDataPath:`/tmp/jobseeker-source-test-${area}`,hhOperationTimeoutSeconds:30,hireHiMaxPages:1,
    additionalMaxPages:1,playwrightHeadless:true,playwrightChromiumPath:undefined,timezone:'UTC',
    browserEnvironment:{lang:'C.UTF-8',path:'/usr/bin:/bin',tmpdir:'/tmp'},atsBoards:[],trudvsemRegion:undefined},
  trace:()=>undefined,errorMessage:String,recordListingCandidate:async()=>true,
};}

test('source registries keep settings and lifecycle isolated',async()=>{
  const first=createSourceRegistry(options('1')),second=createSourceRegistry(options('2'));
  assert.equal((first.getPlatform('hh').template().capabilities as {configuredDefaultArea:string}).configuredDefaultArea,'1');
  assert.equal((second.getPlatform('hh').template().capabilities as {configuredDefaultArea:string}).configuredDefaultArea,'2');
  await Promise.all([first.close(),second.close()]);
});
