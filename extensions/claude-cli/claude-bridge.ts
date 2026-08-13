import { spawn } from 'node:child_process';
import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type ModelCost,
  type Provider,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Usage,
} from '@earendil-works/pi-ai';

export const claudeCliApi = 'claude-cli';
const perMillion = (input: number, output: number, cacheRead: number, cacheWrite: number): ModelCost =>
  ({ input: input / 1e6, output: output / 1e6, cacheRead: cacheRead / 1e6, cacheWrite: cacheWrite / 1e6 });
const modelSpecs = Object.freeze([
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200_000, maxTokens: 32_000, cost: perMillion(15, 75, 1.5, 18.75) },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200_000, maxTokens: 64_000, cost: perMillion(3, 15, 0.3, 3.75) },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxTokens: 8_192, cost: perMillion(1, 5, 0.1, 1.25) },
]);

export interface ClaudeCliProviderOptions {
  readonly executablePath?: string;
  readonly cwd?: string;
  readonly defaultTimeoutMs?: number;
  readonly endpoint?: string;
  readonly endpointToken?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

function contentText(message: Message): string {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content.trim();
    const text = message.content.map((item) => {
      if (item.type === 'image') throw new TypeError('Claude CLI bridge does not support image context.');
      return item.text;
    }).join('\n').trim();
    return text;
  }
  if (message.role === 'assistant') return message.content.map((item) => {
    if (item.type === 'toolCall') throw new TypeError('Claude CLI bridge does not support tool-call context.');
    return item.type === 'thinking' ? `[Thinking]\n${item.thinking}` : item.text;
  }).join('\n').trim();
  return message.content.map((item) => {
    if (item.type === 'image') throw new TypeError('Claude CLI bridge does not support image tool results.');
    return item.text;
  }).join('\n').trim();
}

export function flattenPrompt(messages: readonly Message[]): string {
  const nonempty = messages.map((message) => ({ message, text: contentText(message) })).filter(({ text }) => text.length > 0);
  if (nonempty.length === 1 && nonempty[0]!.message.role === 'user') return nonempty[0]!.text;
  return nonempty.map(({ message, text }) => {
    const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : `Tool ${message.toolName}`;
    return `${label}:\n${text}`;
  }).join('\n\n');
}

export interface ClaudeCliUsage {
  readonly input_tokens?: number; readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number; readonly cache_creation_input_tokens?: number;
}
function nonnegative(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
export function toUsage(raw: ClaudeCliUsage | undefined, totalCostUsd: number | undefined, cost: ModelCost): Usage {
  const input = nonnegative(raw?.input_tokens), output = nonnegative(raw?.output_tokens);
  const cacheRead = nonnegative(raw?.cache_read_input_tokens), cacheWrite = nonnegative(raw?.cache_creation_input_tokens);
  const components = { input: input * cost.input, output: output * cost.output,
    cacheRead: cacheRead * cost.cacheRead, cacheWrite: cacheWrite * cost.cacheWrite };
  const estimated = components.input + components.output + components.cacheRead + components.cacheWrite;
  const authoritative = nonnegative(totalCostUsd);
  const total = totalCostUsd === undefined ? estimated : authoritative;
  const scale = estimated > 0 ? total / estimated : 0;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output,
    cost: { input: components.input * scale, output: components.output * scale,
      cacheRead: components.cacheRead * scale, cacheWrite: components.cacheWrite * scale, total } };
}
export function toStopReason(raw: string | undefined | null, isError: boolean): StopReason {
  if (isError) return 'error';
  if (raw === 'max_tokens') return 'length';
  if (raw === 'tool_use') return 'toolUse';
  return 'stop';
}

const effort: Readonly<Record<string, string>> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
export function buildArgs(model: Model<string>, context: Context, options?: SimpleStreamOptions): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--model', model.id, '--system-prompt', context.systemPrompt ?? '', '--tools', ''];
  if (options?.reasoning && effort[options.reasoning]) args.push('--effort', effort[options.reasoning]!);
  const schema = options?.metadata?.jsonSchema;
  if (schema !== undefined) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

interface StreamState { text: string; thinking: string; contentIndex: number; open: 'text' | 'thinking' | null }
function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function message(model: Model<string>, state: StreamState, usage: Usage, stopReason: StopReason, errorMessage?: string): AssistantMessage {
  const content: (TextContent | ThinkingContent)[] = [];
  if (state.thinking) content.push({ type: 'thinking', thinking: state.thinking });
  if (state.text) content.push({ type: 'text', text: state.text });
  return { role: 'assistant', content, api: claudeCliApi, provider: 'claude-cli', model: model.id,
    usage, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now() };
}

export interface ClaudeSidecarRequest {
  readonly model: string; readonly systemPrompt: string; readonly prompt: string; readonly effort?: string;
  readonly jsonSchema?: unknown;
}
export function sidecarRequest(model: Model<string>, context: Context, options?: SimpleStreamOptions): ClaudeSidecarRequest {
  const selectedEffort = options?.reasoning ? effort[options.reasoning] : undefined;
  const schema = options?.metadata?.jsonSchema;
  return { model: model.id, systemPrompt: context.systemPrompt ?? '', prompt: flattenPrompt(context.messages),
    ...(selectedEffort ? { effort: selectedEffort } : {}), ...(schema === undefined ? {} : { jsonSchema: schema }) };
}

export function claudeCliProvider(providerOptions: ClaudeCliProviderOptions = {}): Provider<string> {
  const models: Model<string>[] = modelSpecs.map((spec) => ({ ...spec, api: claudeCliApi, provider: 'claude-cli',
    baseUrl: providerOptions.endpoint ?? 'local:claude-cli', reasoning: true, input: ['text'],
    thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }));

  const run = (model: Model<string>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream(); const state: StreamState = { text: '', thinking: '', contentIndex: -1, open: null };
    let usage = emptyUsage(); let settled = false; let terminalResult = false; let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined; const transportAbort = new AbortController();
    const partial = (reason: StopReason = 'stop', error?: string) => message(model, state, usage, reason, error);
    const closeBlock = (): void => {
      if (state.open === 'text') stream.push({ type: 'text_end', contentIndex: state.contentIndex, content: state.text, partial: partial() });
      if (state.open === 'thinking') stream.push({ type: 'thinking_end', contentIndex: state.contentIndex, content: state.thinking, partial: partial() });
      state.open = null;
    };
    const finish = (reason: StopReason, error?: string): void => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer); options?.signal?.removeEventListener('abort', abort);
      transportAbort.abort(); if (child && !child.killed) child.kill('SIGTERM'); closeBlock();
      const final = partial(reason, error);
      if (reason === 'error' || reason === 'aborted') stream.push({ type: 'error', reason, error: final });
      else stream.push({ type: 'done', reason, message: final });
      stream.end(final);
    };
    const abort = (): void => finish('aborted', 'Claude CLI request was aborted.');
    if (options?.signal?.aborted) { stream.push({ type: 'start', partial: partial() }); abort(); return stream; }
    options?.signal?.addEventListener('abort', abort, { once: true });
    stream.push({ type: 'start', partial: partial() });
    const timeout = Math.min(options?.timeoutMs ?? Number.POSITIVE_INFINITY,
      providerOptions.defaultTimeoutMs ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(timeout)) timer = setTimeout(() => finish('error', `Claude CLI exceeded ${timeout} ms.`), timeout);

    const delta = (kind: 'text' | 'thinking', value: string): void => {
      if (state.open !== kind) { closeBlock(); state.contentIndex += 1; state.open = kind;
        stream.push(kind === 'text' ? { type: 'text_start', contentIndex: state.contentIndex, partial: partial() }
          : { type: 'thinking_start', contentIndex: state.contentIndex, partial: partial() }); }
      if (kind === 'text') { state.text += value; stream.push({ type: 'text_delta', contentIndex: state.contentIndex, delta: value, partial: partial() }); }
      else { state.thinking += value; stream.push({ type: 'thinking_delta', contentIndex: state.contentIndex, delta: value, partial: partial() }); }
    };
    const line = (raw: string): void => {
      if (settled || !raw.trim()) return;
      let event: Record<string, unknown>; try { event = JSON.parse(raw); } catch { finish('error', 'Claude CLI returned invalid NDJSON.'); return; }
      if (event.type === 'stream_event') {
        const streamEvent = event.event as { delta?: { type?: string; text?: string; thinking?: string } } | undefined;
        if (streamEvent?.delta?.type === 'text_delta' && typeof streamEvent.delta.text === 'string') delta('text', streamEvent.delta.text);
        if (streamEvent?.delta?.type === 'thinking_delta' && typeof streamEvent.delta.thinking === 'string') delta('thinking', streamEvent.delta.thinking);
        return;
      }
      if (event.type !== 'result') return;
      terminalResult = true; const failed = Boolean(event.is_error) || event.subtype !== 'success';
      usage = toUsage(event.usage as ClaudeCliUsage | undefined,
        typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined, model.cost);
      if (!failed && typeof event.result === 'string' && event.result) state.text = event.result;
      finish(toStopReason(typeof event.stop_reason === 'string' ? event.stop_reason : undefined, failed),
        failed ? String(event.result ?? event.subtype ?? 'Claude CLI failed.') : undefined);
    };
    let buffered = '';
    const consume = (chunk: string): void => { buffered += chunk; const lines = buffered.split('\n'); buffered = lines.pop() ?? ''; for (const item of lines) line(item); };
    const completed = (code: number | null, stderr = ''): void => {
      if (buffered.trim()) line(buffered); buffered = '';
      if (!settled && code !== 0) finish('error', `Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`);
      else if (!settled && !terminalResult) finish('error', 'Claude CLI ended without a result event.');
    };

    void (async () => {
      try {
        if (providerOptions.endpoint) {
          const response = await (providerOptions.fetch ?? fetch)(`${providerOptions.endpoint.replace(/\/$/u, '')}/v1/stream`, {
            method: 'POST', headers: { 'content-type': 'application/json',
              ...(providerOptions.endpointToken ? { authorization: `Bearer ${providerOptions.endpointToken}` } : {}) },
            body: JSON.stringify(sidecarRequest(model, context, options)), signal: transportAbort.signal,
          });
          if (!response.ok || !response.body) { finish('error', `Claude CLI sidecar returned HTTP ${response.status}.`); return; }
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          while (true) { const item = await reader.read(); if (item.done) break; consume(item.value); }
          completed(0); return;
        }
        child = spawn(providerOptions.executablePath ?? 'claude', buildArgs(model, context, options), {
          cwd: providerOptions.cwd, env: { ...process.env, ...providerOptions.environment }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        });
        if (!child.stdin || !child.stdout || !child.stderr) {
          finish('error', 'Claude CLI process did not provide piped standard streams.'); return;
        }
        let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', consume); child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
        child.stdin.end(flattenPrompt(context.messages));
        child.once('error', (error) => finish('error', error.message));
        child.once('exit', (code) => completed(code, stderr));
      } catch (error) { if (!settled) finish('error', error instanceof Error ? error.message : String(error)); }
    })();
    return stream;
  };

  return createProvider({ id: 'claude-cli', name: 'Claude CLI', models,
    auth: { apiKey: { name: 'Local Claude CLI', resolve: async () => ({ credential: { type: 'api_key', key: 'local' }, auth: {} }) } },
    api: { stream: run, streamSimple: run } });
}
