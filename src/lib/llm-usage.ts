import { observe, type PromptUsage } from '@flue/runtime';

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

function add(target: LlmUsageTotals, usage: PromptUsage): void {
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

observe((event) => {
  if (event.type !== 'turn' || !event.response.usage) return;
  add(totals, event.response.usage);
  const agent = event.agentName ?? 'unknown';
  let agentTotals = byAgent.get(agent);
  if (!agentTotals) {
    agentTotals = emptyTotals();
    byAgent.set(agent, agentTotals);
  }
  add(agentTotals, event.response.usage);
  const model = `${event.request.providerId}/${event.request.requestedModel}`;
  let modelTotals = byModel.get(model);
  if (!modelTotals) {
    modelTotals = emptyTotals();
    byModel.set(model, modelTotals);
  }
  add(modelTotals, event.response.usage);
});

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
