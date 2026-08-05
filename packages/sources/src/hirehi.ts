import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { errorMessage, sourcesSettings, trace } from './config.ts';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/store';
import { asObject, fetchSourceHtml, htmlText, jobPostings, plainText, sourceUrl, type JsonObject, VacancySearchCollector } from './http.ts';
import type { SearchPlan } from './contract.ts';
import type { SearchPlatform } from './contract.ts';

export const hireHiSpecializations=[
  '1c','analytics','android','backend','business-analyst','ci-cd','cloud','cpp','data-analyst','data-engineer',
  'development','devops','dotnet','frontend','fullstack','go','iac','infrastructure','ios','java','kotlin','kubernetes',
  'manual-qa','ml-ai','mobile','nodejs','observability','php','product-analyst','product-manager','project-manager',
  'python','qa','qa-automation','rust','security','sre-platform','system-analyst',
] as const;
const facets=['all','remote','intern','junior','middle','senior','lead','head'] as const;
const searchSchema=v.strictObject({name:v.pipe(v.string(),v.minLength(2),v.maxLength(80)),
  rationale:v.pipe(v.string(),v.minLength(2),v.maxLength(300)),specialization:v.picklist(hireHiSpecializations),facet:v.picklist(facets)});
export const hireHiSearchProfileSchema=v.strictObject({version:v.literal(1),searches:v.pipe(v.array(searchSchema),v.maxLength(8),
  v.check(searches=>new Set(searches.map(search=>`${search.facet}:${search.specialization}`)).size===searches.length,
    'HireHi searches must use unique facet and specialization pairs'))});
export type HireHiSearchProfile=v.InferOutput<typeof hireHiSearchProfileSchema>;
export type HireHiSearch=HireHiSearchProfile['searches'][number];

export const hireHiPlatform:SearchPlatform<typeof hireHiSearchProfileSchema>={
  id:'hirehi',name:'HireHi',hosts:['hirehi.ru','www.hirehi.ru'],schema:hireHiSearchProfileSchema,template:()=>({platform:'hirehi',version:1,
    purpose:'Validated public HireHi SEO landing pages. The adapter does not call the disallowed HireHi search API.',
    jsonShape:{version:1,searches:[{name:'Supported CV track',rationale:'direct CV evidence',specialization:'one listed specialization',facet:'all'}]},
    capabilities:{specializations:hireHiSpecializations,facets,facetMeaning:{all:'all levels and work formats',remote:'remote vacancies',
      intern:'intern grade',junior:'junior grade',middle:'middle grade',senior:'senior grade',lead:'lead grade',head:'head grade'}},
    rules:['Choose only listed specialization and facet values.','Use all unless the CV clearly supports a narrower facet.',
      'Prefer precise specializations over development.','Do not substitute an adjacent occupation.',
      'Return an empty searches array when HireHi has no specialization supported by the CV.']}),
};

export function hireHiSearchUrl(search:HireHiSearch,page:number):string{
  const path=search.facet==='all'?`/vacancies/${search.specialization}`:`/${search.facet}-${search.specialization}-jobs`;
  const url=new URL(path,'https://hirehi.ru');if(page>1)url.searchParams.set('page',String(page));return url.toString();
}

function scriptJson(html:string,id:string):unknown{
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=html.match(new RegExp(`<script\\b(?=[^>]*\\bid=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`,'i'));
  if(!match)throw new Error(`HireHi page does not contain ${id} data`);return JSON.parse(match[1]!);
}
function itemLists(value:unknown):JsonObject[]{
  if(Array.isArray(value))return value.flatMap(itemLists);const object=asObject(value);if(!object)return[];
  return[...(object['@type']==='ItemList'?[object]:[]),...itemLists(object['@graph'])];
}
export function hireHiListingUrls(html:string):Map<string,string>{
  const urls=new Map<string,string>();
  for(const script of html.matchAll(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi))try{
    for(const list of itemLists(JSON.parse(script[1]!))){const items=Array.isArray(list.itemListElement)?list.itemListElement:[];
      for(const value of items){const item=asObject(value),nested=asObject(item?.item);
        const raw=plainText(item?.url)||plainText(item?.item)||plainText(nested?.url);if(!raw)continue;
        try{const url=sourceUrl('hirehi',raw);if(url.search||url.hash)continue;
          const id=url.pathname.match(/^\/[^/]+\/[^/]+-(\d+)\/?$/)?.[1];if(id)urls.set(id,url.toString());}catch{/* Ignore unrelated invalid structured links. */}
      }
    }
  }catch{/* Ignore unrelated malformed JSON-LD. */}
  return urls;
}
export function hireHiCandidateUrl(id:number,category:string,canonicalUrls:ReadonlyMap<string,string>):string{
  return canonicalUrls.get(String(id))??`https://hirehi.ru/${encodeURIComponent(category)}/job-${id}`;
}
function pause():Promise<void>{return new Promise(resolve=>setTimeout(resolve,250+Math.random()*400));}
function listingJobs(value:unknown):JsonObject[]{
  const jobs=asObject(value)?.jobs;return Array.isArray(jobs)?jobs.map(asObject).filter(job=>job!==null):[];
}
function integer(value:unknown):number|null{const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;}
function parseSalary(value:string):Pick<VacancyInput,'salaryFrom'|'salaryTo'|'salaryCurrency'|'salaryGross'>{
  const normalized=value.replace(/\u00a0/g,' ').trim();if(!normalized||/не указана/i.test(normalized))
    return{salaryFrom:null,salaryTo:null,salaryCurrency:null,salaryGross:null};
  const amounts=[...normalized.matchAll(/\d[\d ]*/g)].map(match=>Number(match[0].replace(/\s/g,''))).filter(Number.isFinite);
  let salaryFrom:number|null=null,salaryTo:number|null=null;
  if(amounts.length>=2)[salaryFrom,salaryTo]=amounts;else if(/^\s*до\b/i.test(normalized))salaryTo=amounts[0]??null;else salaryFrom=amounts[0]??null;
  const salaryCurrency=normalized.includes('₽')||/руб/i.test(normalized)?'RUR':normalized.includes('$')?'USD':normalized.includes('€')?'EUR':null;
  return{salaryFrom,salaryTo,salaryCurrency,salaryGross:null};
}
function workFormat(value:string):string{
  const normalized=value.toLowerCase();return ['удалённо по рф','удалённо','гибрид','офис'].find(format=>normalized.startsWith(format))??'';
}
function listingLocation(value:string):string{const format=workFormat(value);return format?value.slice(format.length).trim():'';}

export async function scrapeHireHi(plan:SearchPlan<HireHiSearch>):Promise<{seen:number;discovered:number}>{
  const collector=new VacancySearchCollector(sourcesSettings().searchNewVacancyLimit);
  const pagesPerSearch=Math.max(1,Math.min(sourcesSettings().hireHiMaxPages,
    Math.floor(sourcesSettings().searchPageBudgetPerPlatform/Math.max(1,plan.searches.length))));
  searches:for(const {search,recipients} of plan.searches)for(let page=1;page<=pagesPerSearch;page++){
    try{
      const url=hireHiSearchUrl(search,page);trace('scrape.search.request',{platform:'hirehi',search:search.name,page,url});
      const {html}=await fetchSourceHtml('hirehi',url),canonicalUrls=hireHiListingUrls(html);
      const listing=asObject(scriptJson(html,'__SSR_JOBS__')),jobs=listingJobs(listing);
      trace('scrape.search.result',{platform:'hirehi',search:search.name,page,found:jobs.length});
      for(const job of jobs){const id=integer(job.id),category=plainText(job.category);if(id&&category)await collector.record({source:'hirehi',sourceId:String(id),
        url:hireHiCandidateUrl(id,category,canonicalUrls),searchName:search.name,title:plainText(job.title)||search.name,
        summary:[plainText(job.company),plainText(job.format),plainText(job.salary_display)].filter(Boolean).join(' '),
        publishedAt:plainText(job.created_at),payload:job},recipients);if(collector.complete)break;}
      if(collector.complete)break searches;if(!jobs.length||listing?.has_more===false)break;await pause();
    }catch(error){console.error(`Failed to read HireHi search ${search.name} page ${page}: ${errorMessage(error)}`);break;}
  }
  return collector.result();
}

export async function normalizeHireHiCandidate(candidate:VacancyCandidate):Promise<VacancyInput>{
  const {html,url}=await fetchSourceHtml('hirehi',candidate.url),posting=jobPostings(html)[0];
  if(!posting)throw new Error(`HireHi vacancy ${candidate.sourceId} has no JobPosting JSON-LD`);
  const canonicalId=url.match(/-(\d+)\/?(?:\?.*)?$/)?.[1];if(canonicalId!==candidate.sourceId)throw new Error('Unexpected HireHi canonical vacancy URL');
  let detail:JsonObject|null=null;try{detail=asObject(scriptJson(html,'vacancy-data-json'));}catch{/* JSON-LD remains authoritative. */}
  const listing=asObject(candidate.payload),name=plainText(posting.title)||candidate.title;
  const employer=plainText(asObject(posting.hiringOrganization)?.name)||plainText(listing?.company)||'Не указано';
  const description=htmlText(plainText(posting.description));if(!name||description.length<20)throw new Error(`HireHi vacancy ${candidate.sourceId} is missing required content`);
  const formatText=plainText(listing?.format)||plainText(detail?.format),format=workFormat(formatText);
  const locations=Array.isArray(posting.jobLocation)?posting.jobLocation:[posting.jobLocation];
  const postingArea=locations.map(location=>plainText(asObject(asObject(location)?.address)?.addressLocality)).find(Boolean)??'';
  const skills=plainText(posting.skills).split(/[;,]/).map(skill=>skill.trim()).filter(skill=>skill.length>1&&!skill.endsWith('...')).slice(0,30);
  const salary=parseSalary(plainText(listing?.salary_display)||plainText(listing?.salary)||plainText(detail?.salary));
  const base={source:'hirehi',sourceId:candidate.sourceId,name,employer,
    area:plainText(detail?.location)||postingArea||listingLocation(formatText)||'Не указано',...salary,
    experience:plainText(listing?.level)||plainText(detail?.level),employment:plainText(posting.employmentType),
    schedule:plainText(posting.workHours),workFormat:format,description,keySkills:skills,url,
    publishedAt:plainText(posting.datePosted)||candidate.publishedAt,sourceQuery:candidate.searchName};
  return{...base,contentHash:createHash('sha256').update(JSON.stringify(base)).digest('hex')};
}
