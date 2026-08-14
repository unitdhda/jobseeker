import { access } from 'node:fs/promises';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  createModels,
  type Api,
  type AssistantMessage,
  type CredentialStore,
  type Model,
  type Models,
  type Provider,
  type ThinkingLevel,
  type Usage,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import type { ModelId } from './config.ts';

export interface LlmUsageTotals {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}
export interface LlmUsageReport extends LlmUsageTotals {
  readonly byAgent: Readonly<Record<string, LlmUsageTotals>>;
  readonly byModel: Readonly<Record<string, LlmUsageTotals>>;
}

interface MutableUsageTotals {
  turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; totalTokens: number; costUsd: number;
}
const emptyUsage = (): MutableUsageTotals => ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 });
const totalUsage = emptyUsage();
const agentUsage = new Map<string, MutableUsageTotals>();
const modelUsage = new Map<string, MutableUsageTotals>();

function addUsage(target: MutableUsageTotals, usage: Usage): void {
  target.turns += 1; target.inputTokens += usage.input; target.outputTokens += usage.output;
  target.cacheReadTokens += usage.cacheRead; target.cacheWriteTokens += usage.cacheWrite;
  target.totalTokens += usage.totalTokens; target.costUsd += usage.cost.total;
}
function frozenTotals(value: MutableUsageTotals): LlmUsageTotals { return Object.freeze({ ...value }); }
function usageRecord(source: Map<string, MutableUsageTotals>): Readonly<Record<string, LlmUsageTotals>> {
  return Object.freeze(Object.fromEntries([...source].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, frozenTotals(value)])));
}

export function recordInProcessUsage(agent: string, model: string, usage: Usage): void {
  if (!agent.trim() || !model.trim()) throw new TypeError('Usage agent and model must be nonempty.');
  addUsage(totalUsage, usage);
  const byAgent = agentUsage.get(agent) ?? emptyUsage(); agentUsage.set(agent, byAgent); addUsage(byAgent, usage);
  const byModel = modelUsage.get(model) ?? emptyUsage(); modelUsage.set(model, byModel); addUsage(byModel, usage);
}

export function llmUsageSnapshot(): LlmUsageReport {
  return Object.freeze({ ...frozenTotals(totalUsage), byAgent: usageRecord(agentUsage), byModel: usageRecord(modelUsage) });
}
export function llmUsageSince(previous: LlmUsageReport): LlmUsageReport {
  const current = llmUsageSnapshot();
  const subtract = (left: LlmUsageTotals, right?: LlmUsageTotals): LlmUsageTotals => Object.freeze({
    turns: left.turns - (right?.turns ?? 0), inputTokens: left.inputTokens - (right?.inputTokens ?? 0),
    outputTokens: left.outputTokens - (right?.outputTokens ?? 0), cacheReadTokens: left.cacheReadTokens - (right?.cacheReadTokens ?? 0),
    cacheWriteTokens: left.cacheWriteTokens - (right?.cacheWriteTokens ?? 0), totalTokens: left.totalTokens - (right?.totalTokens ?? 0),
    costUsd: left.costUsd - (right?.costUsd ?? 0),
  });
  const difference = (values: Readonly<Record<string, LlmUsageTotals>>, before: Readonly<Record<string, LlmUsageTotals>>) =>
    Object.freeze(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, subtract(value, before[key])])));
  return Object.freeze({ ...subtract(current, previous), byAgent: difference(current.byAgent, previous.byAgent),
    byModel: difference(current.byModel, previous.byModel) });
}

export interface ComposeAiOptions {
  readonly credentials?: CredentialStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly builtins?: readonly Provider[];
}

export function composeAiModels(extensionProviders: readonly Provider[], options: ComposeAiOptions = {}): Models {
  const providers = [...(options.builtins ?? builtinProviders()), ...extensionProviders];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider.id?.trim()) throw new TypeError('AI provider ID must be nonempty.');
    if (seen.has(provider.id)) throw new Error(`Duplicate AI provider ID: ${provider.id}.`);
    seen.add(provider.id);
  }
  const environment = options.env ?? process.env;
  const models = createModels({
    credentials: options.credentials,
    authContext: {
      env: async (name) => environment[name],
      fileExists: async (path) => access(path.replace(/^~(?=\/)/u, process.env.HOME ?? '~')).then(() => true, () => false),
    },
  });
  for (const provider of providers) models.setProvider(provider);
  return models;
}

export function resolveModel(models: Pick<Models, 'getModel'>, configured: ModelId | undefined, role: string): Model<Api> {
  if (!configured) throw new Error(`${role} model is not configured.`);
  const slash = configured.indexOf('/');
  const provider = configured.slice(0, slash); const id = configured.slice(slash + 1);
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`${role} model ${configured} is not registered.`);
  return model;
}

export class ModelResponseError extends Error {
  readonly providerMessage: string;
  readonly responseStopReason: 'error' | 'aborted';

  constructor(response: AssistantMessage & { stopReason: 'error' | 'aborted' }) {
    super(`Model response ${response.stopReason}.`);
    this.name = 'ModelResponseError';
    this.responseStopReason = response.stopReason;
    this.providerMessage = response.errorMessage ?? '';
  }
}

export interface JsonModels {
  getModel(provider: string, id: string): Model<Api> | undefined;
  completeSimple(model: Model<Api>, context: { systemPrompt?: string; messages: Array<{ role: 'user'; content: string; timestamp: number }> },
    options?: { reasoning?: ThinkingLevel; maxRetries?: number; signal?: AbortSignal }): Promise<AssistantMessage>;
}
export interface GenerateJsonOptions<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>> {
  readonly models: JsonModels;
  readonly model: ModelId | undefined;
  readonly role: string;
  readonly agent: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly schema: TSchema;
  readonly reasoning?: ThinkingLevel;
  readonly signal?: AbortSignal;
  readonly attempts?: number;
  readonly repair?: (value: unknown) => unknown;
  readonly recordUsage?: (agent: string, model: string, usage: Usage) => Promise<void> | void;
}

function messageText(response: AssistantMessage): string {
  return response.content.filter((part): part is Extract<AssistantMessage['content'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text).join('\n').trim();
}

function balancedJson(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start]; if (first !== '{' && first !== '[') continue;
    const stack: string[] = []; let quoted = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const open = stack.pop();
        if ((open === '{' && character !== '}') || (open === '[' && character !== ']') || open === undefined) break;
        if (stack.length === 0) return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const embedded = balancedJson(trimmed); if (embedded) candidates.push(embedded);
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try { return JSON.parse(candidate); } catch (error) { lastError = error; }
  }
  throw new SyntaxError('Model response did not contain valid JSON.', { cause: lastError });
}

function issuePath(issue: v.BaseIssue<unknown>): string {
  const path = issue.path?.map((item) => String(item.key)).join('.') ?? '';
  return path ? path.slice(0, 120) : '$';
}
export function describeValidationIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.slice(0, 8).map((issue) => {
    // Valibot's default messages may echo arbitrary CV/model values after “received”; feedback needs the constraint, not the secret.
    const message = issue.message.replace(/\s+/gu, ' ').replace(/\s+(?:but\s+)?received(?::)?\s+.*$/iu, '').slice(0, 180);
    return `${issuePath(issue)}: ${message}`;
  }).join('; ').slice(0, 1_500);
}

export async function generateJson<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  options: GenerateJsonOptions<TSchema>,
): Promise<v.InferOutput<TSchema>> {
  const model = resolveModel(options.models, options.model, options.role);
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new RangeError('JSON generation attempts must be from 1 through 3.');
  const jsonInstruction = '\n\nReturn only the requested complete JSON value without Markdown fences or commentary.';
  let feedback = ''; let lastValue: unknown; let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await options.models.completeSimple(model, {
      systemPrompt: options.systemPrompt,
      messages: [{ role: 'user', content: `${options.userPrompt}${jsonInstruction}${feedback}`, timestamp: Date.now() }],
    }, { reasoning: options.reasoning, maxRetries: 2, signal: options.signal });
    const qualifiedModel = `${response.provider}/${response.model}`;
    recordInProcessUsage(options.agent, qualifiedModel, response.usage);
    await options.recordUsage?.(options.agent, qualifiedModel, response.usage);
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new ModelResponseError(response as AssistantMessage & { stopReason: 'error' | 'aborted' });
    }
    try {
      lastValue = extractJson(messageText(response));
      const parsed = v.safeParse(options.schema, lastValue);
      if (parsed.success) return parsed.output;
      lastError = new TypeError(`Invalid model JSON: ${describeValidationIssues(parsed.issues)}`);
      feedback = `\n\nYour previous JSON failed validation. Return a complete corrected JSON value only. Issues: ${describeValidationIssues(parsed.issues)}`;
    } catch (error) {
      lastError = error;
      feedback = '\n\nYour previous response was not valid JSON. Return one complete JSON object or array only.';
    }
  }
  if (options.repair) {
    const repaired = v.safeParse(options.schema, options.repair(lastValue));
    if (repaired.success) return repaired.output;
    lastError = new TypeError(`Invalid repaired JSON: ${describeValidationIssues(repaired.issues)}`);
  }
  throw new Error(`${options.role} JSON generation failed after ${attempts} attempts.`, { cause: lastError });
}
