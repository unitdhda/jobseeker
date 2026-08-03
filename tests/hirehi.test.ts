import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { hireHiPlatform, hireHiSearchProfileSchema, hireHiSearchUrl } from '../src/vacancies/hirehi.ts';
import { getSearchPlatform, searchPlatformIds } from '../src/vacancies/registry.ts';

test('HireHi adapter validates constrained SEO search profiles',()=>{
  const profile={version:1 as const,searches:[{name:'Frontend',rationale:'CV evidence',specialization:'frontend' as const,facet:'all' as const}]};
  assert.equal(v.safeParse(hireHiSearchProfileSchema,profile).success,true);
  assert.equal(hireHiSearchUrl(profile.searches[0],1),'https://hirehi.ru/vacancies/frontend');
  assert.equal(hireHiSearchUrl({...profile.searches[0],facet:'remote'},2),'https://hirehi.ru/remote-frontend-jobs?page=2');
  assert.equal(hireHiPlatform.template().capabilities.specializations instanceof Array,true);
});

test('HireHi is registered through the common vacancy-platform interface',()=>{
  assert.ok(searchPlatformIds.includes('hirehi'));
  const adapter=getSearchPlatform('hirehi');
  assert.equal(adapter.id,'hirehi');assert.equal(typeof adapter.discover,'function');assert.equal(typeof adapter.normalize,'function');
});
