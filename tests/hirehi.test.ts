import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { hireHiCandidateUrl, hireHiListingUrls, hireHiPlatform, hireHiSearchProfileSchema, hireHiSearchUrl } from '../src/vacancies/hirehi.ts';
import { getSearchPlatform, searchPlatformIds } from '../src/vacancies/registry.ts';

test('HireHi adapter validates constrained SEO search profiles',()=>{
  const profile={version:1 as const,searches:[{name:'Frontend',rationale:'CV evidence',specialization:'frontend' as const,facet:'all' as const}]};
  assert.equal(v.safeParse(hireHiSearchProfileSchema,profile).success,true);
  assert.equal(hireHiSearchUrl(profile.searches[0],1),'https://hirehi.ru/vacancies/frontend');
  assert.equal(hireHiSearchUrl({...profile.searches[0],facet:'remote'},2),'https://hirehi.ru/remote-frontend-jobs?page=2');
  assert.equal(hireHiPlatform.template().capabilities.specializations instanceof Array,true);
});

test('HireHi extracts safe canonical vacancy URLs from listing JSON-LD',()=>{
  const html=`
    <script type="application/ld+json">not-json</script>
    <script nonce="test" type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@graph':[{
      '@type':'ItemList',itemListElement:[
        {'@type':'ListItem',url:'https://hirehi.ru/development/frontend-razrabotchik-71268'},
        {'@type':'ListItem',item:{url:'https://www.hirehi.ru/development/backend-developer-71199'}},
        {'@type':'ListItem',url:'https://example.com/development/external-70000'},
        {'@type':'ListItem',url:'https://attacker@hirehi.ru/development/unsafe-70001'},
        {'@type':'ListItem',url:'https://hirehi.ru/vacancies/frontend'},
        {'@type':'ListItem',url:'https://hirehi.ru/development/queried-70002?ref=list'},
      ],
    }]})}</script>`;
  const urls=hireHiListingUrls(html);
  assert.deepEqual([...urls],[
    ['71268','https://hirehi.ru/development/frontend-razrabotchik-71268'],
    ['71199','https://www.hirehi.ru/development/backend-developer-71199'],
  ]);
});

test('HireHi uses a canonical listing URL and retains the legacy fallback',()=>{
  const canonical=new Map([['71268','https://hirehi.ru/development/frontend-razrabotchik-71268']]);
  assert.equal(hireHiCandidateUrl(71268,'development',canonical),canonical.get('71268'));
  assert.equal(hireHiCandidateUrl(71247,'development',canonical),'https://hirehi.ru/development/job-71247');
});

test('HireHi is registered through the common vacancy-platform interface',()=>{
  assert.ok(searchPlatformIds.includes('hirehi'));
  const adapter=getSearchPlatform('hirehi');
  assert.equal(adapter.id,'hirehi');assert.equal(typeof adapter.discover,'function');assert.equal(typeof adapter.normalize,'function');
});
