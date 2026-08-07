import { contentText, type ModelThinkingLevel, type Usage } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { recordLlmUsageEvent } from './postgres.ts';

function modelParts(value:string):[string,string]{
  const slash=value.indexOf('/');
  if(slash<1||slash===value.length-1)throw new Error(`Invalid model identifier: ${value}`);
  return [value.slice(0,slash),value.slice(slash+1)];
}
function jsonText(text:string):unknown{
  const trimmed=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(trimmed);}catch{
    const start=Math.min(...['{','['].map(char=>{const index=trimmed.indexOf(char);return index<0?Infinity:index;}));
    const end=Math.max(trimmed.lastIndexOf('}'),trimmed.lastIndexOf(']'));
    if(!Number.isFinite(start)||end<=start)throw new Error('AI response did not contain JSON.');
    return JSON.parse(trimmed.slice(start,end+1));
  }
}

const jsonValidationAttempts=3;
const shownValidationIssues=8;
const receivedValueLength=160;

/**
 * The message is written for the model that has to fix it, so every issue carries the value that was rejected and
 * what was expected instead. A path and a rule name alone left the model guessing which of its items was wrong.
 */
export function describeValidationIssues(validationIssues:readonly v.BaseIssue<unknown>[]):string{
  const shown=validationIssues.slice(0,shownValidationIssues).map(issue=>{
    const received=String(issue.received);
    const value=received.length>receivedValueLength?`${received.slice(0,receivedValueLength-1)}…`:received;
    const expected=issue.expected==null?'':`, expected ${issue.expected}`;
    return `${v.getDotPath(issue)??'(root)'}: ${issue.message} — received ${value}${expected}`;
  });
  const omitted=validationIssues.length-shown.length;
  return `${shown.join('; ')}${omitted>0?`; and ${omitted} further issue${omitted===1?'':'s'}`:''}`;
}
function invalidJsonError(agent:string,parsed:unknown,validationIssues:readonly v.BaseIssue<unknown>[]):Error{
  const shape=Array.isArray(parsed)?`array(${parsed.length})`:parsed&&typeof parsed==='object'
    ?`object keys=${Object.keys(parsed).slice(0,12).join(',')}`:typeof parsed;
  return new Error(`AI returned invalid ${agent} JSON (${shape}): ${describeValidationIssues(validationIssues)}`);
}

export async function generateJson<TSchema extends v.BaseSchema<unknown,unknown,v.BaseIssue<unknown>>>(options:{
  userId:string;agent:string;model:string|undefined;thinking:ModelThinkingLevel;system:string;prompt:string;schema:TSchema;
  signal?:AbortSignal;
  /**
   * Last-resort salvage for a shape the model keeps getting wrong. It runs only after every attempt has failed
   * validation, so the model always gets its own chance to correct the response first.
   */
  repair?:(value:unknown)=>unknown;
}):Promise<v.InferOutput<TSchema>>{
  if(!options.model)throw new Error(`No AI model is configured for ${options.agent}; set AI_MODEL / AI_SCORING_MODEL.`);
  const [provider,id]=modelParts(options.model),models=aiModels(),model=models.getModel(provider,id);
  if(!model)throw new Error(`Configured AI model is unavailable: ${options.model}`);
  let correction='';let lastError:Error|undefined;let lastParsed:unknown;let parsedAny=false;
  for(let attempt=1;attempt<=jsonValidationAttempts;attempt++){
    const response=await models.completeSimple(model,{systemPrompt:options.system,messages:[{
      role:'user',content:`${options.prompt}\n\nReturn only the requested JSON value without Markdown or commentary.${correction}`,
      timestamp:Date.now(),
    }]},{reasoning:options.thinking==='off'?undefined:options.thinking,signal:options.signal,
      maxRetries:2,maxRetryDelayMs:60_000});
    await recordLlmUsage(options.userId,options.agent,options.model,response.usage);
    if(response.stopReason==='error'||response.stopReason==='aborted')throw new Error(response.errorMessage??'AI request failed.');
    try{
      const parsed=jsonText(contentText(response.content)),result=v.safeParse(options.schema,parsed);
      if(result.success)return result.output;
      lastParsed=parsed;parsedAny=true;
      lastError=invalidJsonError(options.agent,parsed,result.issues);
    }catch(error){lastError=error instanceof Error?error:new Error(String(error));}
    if(attempt<jsonValidationAttempts){
      console.warn(`Retrying ${options.agent} after invalid JSON (${attempt}/${jsonValidationAttempts-1}): ${lastError.message}`);
      correction=`\n\nThe previous response failed strict validation: ${lastError.message}. Correct those exact errors `+
        'and return the corrected JSON value in full. Include every required field and do not add, rename, or wrap fields.';
    }
  }
  if(options.repair&&parsedAny){
    const repaired=v.safeParse(options.schema,options.repair(lastParsed));
    if(repaired.success){
      console.warn(`Repaired ${options.agent} JSON locally after ${jsonValidationAttempts} failed attempts: ${lastError?.message}`);
      return repaired.output;
    }
  }
  throw lastError??new Error(`AI returned invalid ${options.agent} JSON.`);
}


export interface LlmUsageTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface LlmUsageReport extends LlmUsageTotals {
  byAgent: Record<string, LlmUsageTotals>;
  byModel: Record<string, LlmUsageTotals>;
}

function emptyTotals(): LlmUsageTotals {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const totals = emptyTotals();
const byAgent = new Map<string, LlmUsageTotals>();
const byModel = new Map<string, LlmUsageTotals>();

function add(target: LlmUsageTotals, usage: Usage): void {
  target.turns++;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;
}

export async function recordLlmUsage(userId: string, agent: string, model: string, usage: Usage): Promise<void> {
  add(totals,usage);
  let agentTotals=byAgent.get(agent);
  if(!agentTotals){agentTotals=emptyTotals();byAgent.set(agent,agentTotals);}
  add(agentTotals,usage);
  let modelTotals=byModel.get(model);
  if(!modelTotals){modelTotals=emptyTotals();byModel.set(model,modelTotals);}
  add(modelTotals,usage);
  await recordLlmUsageEvent(userId, agent, model, {
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens, costUsd: usage.cost.total,
  });
}

function copy(source: LlmUsageTotals): LlmUsageTotals {
  return { ...source, cost: { ...source.cost } };
}

function copyBreakdown(source: Map<string, LlmUsageTotals>): Record<string, LlmUsageTotals> {
  return Object.fromEntries([...source].map(([key, usage]) => [key, copy(usage)]));
}

export function llmUsageSnapshot(): LlmUsageReport {
  return { ...copy(totals), byAgent: copyBreakdown(byAgent), byModel: copyBreakdown(byModel) };
}

function subtract(current: LlmUsageTotals, previous?: LlmUsageTotals): LlmUsageTotals {
  const before = previous ?? emptyTotals();
  return {
    turns: current.turns - before.turns,
    input: current.input - before.input,
    output: current.output - before.output,
    cacheRead: current.cacheRead - before.cacheRead,
    cacheWrite: current.cacheWrite - before.cacheWrite,
    totalTokens: current.totalTokens - before.totalTokens,
    cost: {
      input: current.cost.input - before.cost.input,
      output: current.cost.output - before.cost.output,
      cacheRead: current.cost.cacheRead - before.cost.cacheRead,
      cacheWrite: current.cost.cacheWrite - before.cost.cacheWrite,
      total: current.cost.total - before.cost.total,
    },
  };
}

function subtractBreakdown(current: Record<string, LlmUsageTotals>, previous: Record<string, LlmUsageTotals>): Record<string, LlmUsageTotals> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return Object.fromEntries([...keys].map((key) =>
    [key, subtract(current[key] ?? emptyTotals(), previous[key])])
    .filter(([, usage]) => (usage as LlmUsageTotals).turns > 0));
}

export function llmUsageSince(previous: LlmUsageReport): LlmUsageReport {
  const current = llmUsageSnapshot();
  return { ...subtract(current, previous),
    byAgent: subtractBreakdown(current.byAgent, previous.byAgent),
    byModel: subtractBreakdown(current.byModel, previous.byModel) };
}

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createModels, type Models } from '@earendil-works/pi-ai';
import { createCredentialStore } from './ai-auth.ts';
import { extensionAiProviders } from './vacancies/providers.ts';

let configuredModels: Models | undefined;

/**
 * The model catalog behind every request. No provider or model is chosen here: the built-in catalog is registered
 * whole, extension providers on top, and which of them actually serves traffic is decided entirely by the model
 * identifiers in AI_MODEL and friends plus whichever credentials the store or the environment supplies.
 */
export function aiModels(): Models {
  if (configuredModels) return configuredModels;
  const models = createModels({ credentials: createCredentialStore() });
  for (const provider of builtinProviders()) models.setProvider(provider);
  for (const provider of extensionAiProviders) models.setProvider(provider);
  configuredModels = models;
  return models;
}
