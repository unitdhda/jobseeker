import { timingSafeEqual } from 'node:crypto';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { TelegramMode } from './config.ts';

export interface WebPorts {
  persistenceReady(): Promise<'postgres'>;
  engineReady(): boolean;
  claimTelegramUpdate(updateId: number, retryProcessing?: boolean): Promise<boolean>;
  completeTelegramUpdate(updateId: number): Promise<boolean>;
  failTelegramUpdate(updateId: number, error: unknown): Promise<boolean>;
  handleTelegramUpdate(update: unknown): Promise<void>;
}
export interface WebOptions {
  readonly telegramMode: TelegramMode;
  readonly webhookSecret?: string;
  readonly ports: WebPorts;
  readonly maximumWebhookBytes?: number;
}

export function validWebhookSecret(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/u.test(value);
}
export function webhookSecretMatches(expected: string, received: string | undefined): boolean {
  if (!validWebhookSecret(expected) || typeof received !== 'string') return false;
  const left = Buffer.from(expected); const right = Buffer.from(received);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function updateId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('Invalid Telegram update ID.');
  return value as number;
}
async function boundedJson(request: Request, maximum: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new RangeError('Webhook body is too large.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximum) throw new RangeError('Webhook body is too large.');
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createWebApp(options: WebOptions): Hono {
  const app = new Hono(); const maximum = options.maximumWebhookBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10 * 1024 * 1024) throw new RangeError('Invalid webhook body limit.');
  app.get('/health', (context) => context.json({ ok: true }));
  app.get('/ready', async (context) => {
    try {
      const persistence = await options.ports.persistenceReady();
      if (!options.ports.engineReady()) throw new Error('Required engine ownership is unavailable.');
      return context.json({ ok: true, persistence });
    } catch { return context.json({ ok: false }, 503); }
  });
  if (options.telegramMode === 'webhook') {
    if (!validWebhookSecret(options.webhookSecret)) throw new TypeError('Webhook mode requires a valid URL-safe secret.');
    app.post('/telegram/webhook', async (context) => {
      if (!webhookSecretMatches(options.webhookSecret!, context.req.header('x-telegram-bot-api-secret-token'))) {
        return context.json({ ok: false }, 401);
      }
      let payload: unknown; let id: number;
      try {
        payload = await boundedJson(context.req.raw, maximum);
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('Invalid webhook JSON.');
        id = updateId((payload as Record<string, unknown>).update_id);
      } catch (error) {
        return context.json({ ok: false, error: error instanceof RangeError ? 'too_large' : 'invalid' }, error instanceof RangeError ? 413 : 400);
      }
      const claimed = await options.ports.claimTelegramUpdate(id, true);
      if (!claimed) return context.json({ ok: true, duplicate: true });
      try {
        await options.ports.handleTelegramUpdate(payload);
        await options.ports.completeTelegramUpdate(id);
        return context.json({ ok: true });
      } catch (error) {
        await options.ports.failTelegramUpdate(id, error).catch(() => false);
        return context.json({ ok: false }, 500);
      }
    });
  }
  return app;
}

export interface HttpServerHandle { readonly server: ServerType; close(): Promise<void> }
export function startHttpServer(app: Hono, port: number, hostname = '0.0.0.0', serverFactory = serve): HttpServerHandle {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError('HTTP port must be 1 through 65535.');
  const server = serverFactory({ fetch: app.fetch, port, hostname }); let closed = false;
  return Object.freeze({ server, close: async () => { if (closed) return; closed = true;
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())); } });
}

export interface ShutdownComponents {
  readonly stopEngine: () => Promise<void>;
  readonly stopTelegram: () => Promise<void>;
  readonly stopWorker: () => Promise<void>;
  readonly stopHttp: () => Promise<void>;
  readonly closeApplication: () => Promise<void>;
}
export function createOrderedShutdown(components: ShutdownComponents): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => promise ??= (async () => {
    const failures: unknown[] = [];
    for (const operation of [components.stopEngine, components.stopTelegram, components.stopWorker,
      components.stopHttp, components.closeApplication]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Ordered application shutdown failed.');
  })();
}
