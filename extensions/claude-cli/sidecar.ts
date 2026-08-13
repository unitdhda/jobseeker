import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import ipaddr from 'ipaddr.js';
import type { ClaudeSidecarRequest } from './claude-bridge.ts';

export interface ClaudeOAuthFile {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly refreshToken?: string;
}
export interface ClaudeSidecarOptions {
  readonly host: string; readonly port: number; readonly token: string; readonly executablePath: string;
  readonly cwd?: string; readonly timeoutMs: number; readonly maxBodyBytes: number; readonly maxConcurrency: number;
  readonly environment?: Readonly<Record<string, string | undefined>>; readonly oauthFile?: string;
}

function privateBindHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (!isIP(host)) return false;
  try { const range = ipaddr.process(host).range(); return ['loopback', 'private', 'linkLocal', 'uniqueLocal'].includes(range); }
  catch { return false; }
}
function digest(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash('sha256').update(value).digest());
}
export function validBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

function validRequest(value: unknown): ClaudeSidecarRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid sidecar request.');
  const request = value as Record<string, unknown>;
  const allowed = new Set(['model', 'systemPrompt', 'prompt', 'effort', 'jsonSchema']);
  if (Object.keys(request).some((key) => !allowed.has(key))) throw new TypeError('Sidecar request contains forbidden fields.');
  for (const key of ['model', 'systemPrompt', 'prompt']) if (typeof request[key] !== 'string') throw new TypeError(`Invalid sidecar ${key}.`);
  if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(request.model as string)) throw new TypeError('Invalid sidecar model.');
  if ((request.systemPrompt as string).length > 100_000 || (request.prompt as string).length > 2_000_000) throw new RangeError('Sidecar prompt is too large.');
  if (request.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(request.effort))) {
    throw new TypeError('Invalid sidecar effort.');
  }
  return request as unknown as ClaudeSidecarRequest;
}

export function sidecarArgs(request: ClaudeSidecarRequest): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--model', request.model, '--system-prompt', request.systemPrompt, '--tools', ''];
  if (request.effort) args.push('--effort', request.effort);
  if (request.jsonSchema !== undefined) args.push('--json-schema', JSON.stringify(request.jsonSchema));
  return args;
}

async function body(req: IncomingMessage, maximum: number): Promise<unknown> {
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Uint8Array.from(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); size += bytes.byteLength;
    if (size > maximum) throw new RangeError('Request body is too large.'); chunks.push(bytes);
  }
  const combined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(combined));
}
async function readOAuth(path: string | undefined): Promise<ClaudeOAuthFile | null> {
  if (!path) return null;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ClaudeOAuthFile;
  if (!parsed.accessToken || typeof parsed.accessToken !== 'string') throw new TypeError('Invalid Claude OAuth file.');
  return parsed;
}
async function writeOAuth(path: string, oauth: ClaudeOAuthFile): Promise<void> {
  if (!oauth.accessToken || typeof oauth.accessToken !== 'string') throw new TypeError('Invalid rotated Claude OAuth data.');
  const temporary = join(dirname(path), `.claude-oauth-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(oauth)}\n`, { mode: 0o600 }); await rename(temporary, path);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}

export function createClaudeSidecar(options: ClaudeSidecarOptions): Server {
  if (!privateBindHost(options.host)) throw new TypeError('Claude sidecar must bind to loopback or a private address.');
  if (!options.token || options.token.length < 16) throw new TypeError('Claude sidecar token must contain at least 16 characters.');
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535
    || !Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1
    || !Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new RangeError('Invalid Claude sidecar limits.');
  let active = 0;
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      try { const oauth = await readOAuth(options.oauthFile);
        json(res, 200, { ok: true, auth: oauth ? 'oauth-file' : 'environment', ...(oauth?.expiresAt ? { expiresAt: oauth.expiresAt } : {}) }); }
      catch { json(res, 503, { ok: false, auth: 'invalid' }); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/stream') { json(res, 404, { error: 'not found' }); return; }
    if (!validBearer(req.headers.authorization, options.token)) { json(res, 401, { error: 'unauthorized' }); return; }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { json(res, 415, { error: 'JSON required' }); return; }
    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > options.maxBodyBytes)) {
      req.resume(); json(res, 413, { error: 'Request body is too large.' }); return;
    }
    if (active >= options.maxConcurrency) { json(res, 429, { error: 'busy' }); return; }
    active += 1;
    try {
      const request = validRequest(await body(req, options.maxBodyBytes)); const oauth = await readOAuth(options.oauthFile);
      const child = spawn(options.executablePath, sidecarArgs(request), { cwd: options.cwd, shell: false,
        env: { ...process.env, ...options.environment, ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'] });
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Claude process did not provide piped streams.');
      let disconnected = false; const kill = (): void => { disconnected = true; if (!child.killed) child.kill('SIGTERM'); };
      req.once('aborted', kill); res.once('close', () => { if (!res.writableEnded) kill(); });
      const timer = setTimeout(() => { if (!child.killed) child.kill('SIGTERM'); }, options.timeoutMs);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      child.stdin.end(request.prompt);
      let buffered = ''; let stderr = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
      const childExit = new Promise<number | null>((resolveChild) => child.once('exit', resolveChild));
      child.stdout.setEncoding('utf8');
      for await (const chunk of child.stdout) {
        buffered += chunk; const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.oauth && options.oauthFile) { await writeOAuth(options.oauthFile, event.oauth as ClaudeOAuthFile); delete event.oauth; }
            if (!disconnected) res.write(`${JSON.stringify(event)}\n`);
          } catch (error) {
            if (!disconnected) res.write(`${JSON.stringify({ type: 'result', subtype: 'error', is_error: true,
              result: error instanceof Error ? error.message : 'Invalid sidecar stream event.' })}\n`);
          }
        }
      }
      const code = await childExit;
      clearTimeout(timer); if (buffered.trim() && !disconnected) res.write(`${buffered}\n`);
      if (code !== 0 && !disconnected) res.write(`${JSON.stringify({ type: 'result', subtype: 'error', is_error: true,
        result: `Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}` })}\n`);
      if (!disconnected) res.end();
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof RangeError ? 413 : 400,
        { error: error instanceof Error ? error.message : 'invalid request' });
      else if (!res.writableEnded) res.end();
    } finally { active -= 1; }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const server = createClaudeSidecar({ host: env.BIND_HOST ?? '127.0.0.1', port: Number(env.PORT ?? 8787),
    token: env.CLAUDE_CLI_TOKEN ?? '', executablePath: env.CLAUDE_CLI_PATH ?? 'claude', cwd: env.CLAUDE_CLI_CWD,
    timeoutMs: Number(env.CLAUDE_CLI_TIMEOUT_MS ?? 300_000), maxBodyBytes: Number(env.CLAUDE_CLI_MAX_BODY_BYTES ?? 2_200_000),
    maxConcurrency: Number(env.CLAUDE_CLI_MAX_CONCURRENCY ?? 2), oauthFile: env.CLAUDE_OAUTH_FILE });
  server.listen(Number(env.PORT ?? 8787), env.BIND_HOST ?? '127.0.0.1');
}
