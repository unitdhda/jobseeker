import { contentText, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { aiModels } from './openai-codex.ts';
import { recordLlmUsage } from './llm-usage.ts';

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

export async function generateJson<TSchema extends v.BaseSchema<unknown,unknown,v.BaseIssue<unknown>>>(options:{
  agent:string;model:string;thinking:ModelThinkingLevel;system:string;prompt:string;schema:TSchema;
}):Promise<v.InferOutput<TSchema>>{
  const [provider,id]=modelParts(options.model),models=aiModels(),model=models.getModel(provider,id);
  if(!model)throw new Error(`Configured AI model is unavailable: ${options.model}`);
  const response=await models.completeSimple(model,{systemPrompt:options.system,messages:[{
    role:'user',content:`${options.prompt}\n\nReturn only the requested JSON value without Markdown or commentary.`,timestamp:Date.now(),
  }]},{reasoning:options.thinking==='off'?undefined:options.thinking,maxRetries:2,maxRetryDelayMs:60_000});
  recordLlmUsage(options.agent,options.model,response.usage);
  if(response.stopReason==='error'||response.stopReason==='aborted')throw new Error(response.errorMessage??'AI request failed.');
  const result=v.safeParse(options.schema,jsonText(contentText(response.content)));
  if(!result.success){const issues=result.issues.slice(0,8).map(issue=>`${v.getDotPath(issue)??'(root)'}: ${issue.message}`);
    throw new Error(`AI returned invalid ${options.agent} JSON: ${issues.join('; ')}`);}
  return result.output;
}
