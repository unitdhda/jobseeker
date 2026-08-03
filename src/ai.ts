import { contentText, type ModelThinkingLevel, type Usage } from '@earendil-works/pi-ai';
import * as v from 'valibot';

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

function invalidJsonError(agent:string,parsed:unknown,validationIssues:readonly v.BaseIssue<unknown>[]):Error{
  const issues=validationIssues.slice(0,8).map(issue=>`${v.getDotPath(issue)??'(root)'}: ${issue.message}`);
  const shape=Array.isArray(parsed)?`array(${parsed.length})`:parsed&&typeof parsed==='object'
    ?`object keys=${Object.keys(parsed).slice(0,12).join(',')}`:typeof parsed;
  return new Error(`AI returned invalid ${agent} JSON (${shape}): ${issues.join('; ')}`);
}

export async function generateJson<TSchema extends v.BaseSchema<unknown,unknown,v.BaseIssue<unknown>>>(options:{
  userId:string;agent:string;model:string;thinking:ModelThinkingLevel;system:string;prompt:string;schema:TSchema;
}):Promise<v.InferOutput<TSchema>>{
  const [provider,id]=modelParts(options.model),models=aiModels(),model=models.getModel(provider,id);
  if(!model)throw new Error(`Configured AI model is unavailable: ${options.model}`);
  let correction='';let lastError:Error|undefined;
  for(let attempt=1;attempt<=jsonValidationAttempts;attempt++){
    const response=await models.completeSimple(model,{systemPrompt:options.system,messages:[{
      role:'user',content:`${options.prompt}\n\nReturn only the requested JSON value without Markdown or commentary.${correction}`,
      timestamp:Date.now(),
    }]},{reasoning:options.thinking==='off'?undefined:options.thinking,maxRetries:2,maxRetryDelayMs:60_000});
    await recordLlmUsage(options.userId,options.agent,options.model,response.usage);
    if(response.stopReason==='error'||response.stopReason==='aborted')throw new Error(response.errorMessage??'AI request failed.');
    try{
      const parsed=jsonText(contentText(response.content)),result=v.safeParse(options.schema,parsed);
      if(result.success)return result.output;
      lastError=invalidJsonError(options.agent,parsed,result.issues);
    }catch(error){lastError=error instanceof Error?error:new Error(String(error));}
    if(attempt<jsonValidationAttempts){
      console.warn(`Retrying ${options.agent} after invalid JSON (${attempt}/${jsonValidationAttempts-1}).`);
      correction=`\n\nThe previous response failed strict validation: ${lastError.message}. Correct those exact errors. `+
        'Include every required field and do not add, rename, or wrap fields.';
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
  await postgresQuery(`insert into usage_events(user_id,kind,occurred_at,agent,model,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,total_tokens,cost_usd) values($1,'llm',now(),$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId,agent,model,usage.input,usage.output,usage.cacheRead,usage.cacheWrite,usage.totalTokens,usage.cost.total]);
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

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createModels, type Models, type OAuthCredential, type Provider } from '@earendil-works/pi-ai';
import { getEncryptedRuntimeState, putEncryptedRuntimeState } from './runtime-state.ts';
import { postgresQuery, withPostgresTransaction } from './postgres.ts';

const providerId = 'openai-codex';
const cloudAuthPath = 'oauth/codex.json';
let refreshInFlight: Promise<OAuthCredential> | undefined;

function authPath(): string {
  return resolve(process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
}

function usesCloudCredentialStore(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    && process.env.SUPABASE_STORAGE_BUCKET && process.env.RUNTIME_STATE_ENCRYPTION_KEY);
}

async function readDocument(): Promise<Record<string, unknown>> {
  if (usesCloudCredentialStore()) {
    const encrypted = await getEncryptedRuntimeState(cloudAuthPath);
    if (!encrypted) throw new Error('OpenAI Codex OAuth is not configured in encrypted cloud storage.');
    try { return JSON.parse(Buffer.from(encrypted).toString('utf8')) as Record<string, unknown>; }
    catch (error) { throw new Error('OpenAI Codex OAuth cloud document is invalid.', { cause: error }); }
  }
  try {
    const document = JSON.parse(await readFile(authPath(), 'utf8')) as Record<string, unknown>;
    await chmod(authPath(), 0o600);
    return document;
  } catch (error) {
    throw new Error(`OpenAI Codex OAuth is not configured at ${authPath()}.`, { cause: error });
  }
}

async function readCredential(): Promise<OAuthCredential> {
  const credential = (await readDocument())[providerId] as Partial<OAuthCredential> | undefined;
  if (credential?.type !== 'oauth' || !credential.access || !credential.refresh || !credential.expires) {
    throw new Error('OpenAI Codex OAuth credential is missing.');
  }
  return credential as OAuthCredential;
}

async function persistCredential(credential: OAuthCredential): Promise<void> {
  const document: Record<string, unknown> = await readDocument().catch(() => ({}));
  document[providerId] = credential;
  if (usesCloudCredentialStore()) {
    await putEncryptedRuntimeState(cloudAuthPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
    return;
  }
  const path = authPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function refreshCredential(source: Provider): Promise<OAuthCredential> {
  const refresh = async (): Promise<OAuthCredential> => {
    const current = await readCredential();
    if (current.expires > Date.now() + 60_000) return current;
    const oauth = source.auth.oauth;
    if (!oauth) throw new Error('OpenAI Codex provider has no OAuth implementation.');
    const refreshed = await oauth.refresh(current);
    await persistCredential(refreshed);
    return refreshed;
  };
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('jobseeker-openai-codex-refresh'))");
    return refresh();
  });
}

async function validCredential(source: Provider): Promise<OAuthCredential> {
  const credential = await readCredential();
  if (credential.expires > Date.now() + 60_000) return credential;
  refreshInFlight ??= refreshCredential(source).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

let configuredModels: Models | undefined;

export function aiModels(): Models {
  if (configuredModels) return configuredModels;
  const models=createModels();
  models.setProvider(openaiProvider());
  const source=openaiCodexProvider(),oauth=source.auth.oauth;
  if(!oauth)throw new Error('OpenAI Codex provider has no OAuth implementation.');
  models.setProvider({...source,auth:{apiKey:{name:'OpenAI Codex OAuth',async resolve(){
    const credential=await validCredential(source);
    return {auth:await oauth.toAuth(credential),source:'OpenAI Codex OAuth'};
  }}}});
  configuredModels=models;
  return models;
}
