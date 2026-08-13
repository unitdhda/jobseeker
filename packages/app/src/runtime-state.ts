import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ExtensionState } from './extensions.ts';
import { config, type AppConfig } from './config.ts';

const magic = Buffer.from('JSRS', 'ascii');
const version = 1;
const ivLength = 12;
const tagLength = 16;
const maximumStateBytes = 200 * 1024 * 1024;
const safeSegment = /^[a-zA-Z0-9._-]+$/u;

export interface RuntimeStateSettings {
  readonly url?: string;
  readonly key?: string;
  readonly bucket?: string;
  readonly encryptionKey?: string;
}
export interface RuntimeStateOptions extends RuntimeStateSettings {
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly maximumBytes?: number;
}

function settingsOf(value: AppConfig | RuntimeStateSettings = config): RuntimeStateSettings {
  if ('stateStorageUrl' in value) {
    const app = value as AppConfig;
    return { url: app.stateStorageUrl, key: app.stateStorageKey,
      bucket: app.stateStorageBucket, encryptionKey: app.runtimeStateEncryptionKey };
  }
  return value as RuntimeStateSettings;
}
export function runtimeStateConfigured(value: AppConfig | RuntimeStateSettings = config): boolean {
  const settings = settingsOf(value);
  return Boolean(settings.url && settings.key && settings.bucket && settings.encryptionKey);
}

export function validateRuntimeStatePath(path: string): string {
  if (typeof path !== 'string' || path.length > 512 || /[\\?#\u0000-\u001f\u007f]/u.test(path)) {
    throw new TypeError('Invalid runtime-state object path.');
  }
  const segments = path.split('/');
  if (!['oauth', 'browser', 'healthcheck'].includes(segments[0] ?? '') || segments.length < 2
    || segments.some((segment) => !safeSegment.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError('Runtime-state path must be a safe descendant of oauth, browser, or healthcheck.');
  }
  return path;
}
function encryptionKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/u.test(hex)) throw new TypeError('Runtime-state encryption key must be 32-byte hexadecimal.');
  return Buffer.from(hex, 'hex');
}

export function encryptRuntimeState(path: string, plaintext: Uint8Array, keyHex: string | undefined = config.runtimeStateEncryptionKey): Uint8Array {
  const canonicalPath = validateRuntimeStatePath(path); const key = encryptionKey(keyHex);
  if (plaintext.byteLength > maximumStateBytes) throw new RangeError('Runtime-state plaintext is too large.');
  const iv = randomBytes(ivLength); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(canonicalPath, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); const tag = cipher.getAuthTag();
  return Uint8Array.from(Buffer.concat([magic, Buffer.from([version]), iv, tag, ciphertext]));
}

interface JsonEnvelope { readonly version: number; readonly iv: string; readonly tag: string; readonly ciphertext: string }
function strictBase64(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`Invalid runtime-state JSON ${name}.`);
  }
  return Buffer.from(value, 'base64');
}
function envelopeParts(encrypted: Uint8Array): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const bytes = Buffer.from(encrypted);
  if (bytes.subarray(0, magic.length).equals(magic)) {
    if (bytes.length < magic.length + 1 + ivLength + tagLength || bytes[magic.length] !== version) {
      throw new TypeError('Unsupported runtime-state binary envelope.');
    }
    const offset = magic.length + 1;
    return { iv: bytes.subarray(offset, offset + ivLength), tag: bytes.subarray(offset + ivLength, offset + ivLength + tagLength),
      ciphertext: bytes.subarray(offset + ivLength + tagLength) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new TypeError('Invalid runtime-state envelope.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'ciphertext,iv,tag,version') throw new TypeError('Invalid runtime-state JSON envelope.');
  const value = parsed as JsonEnvelope;
  if (value.version !== 1) throw new TypeError('Unsupported runtime-state JSON envelope.');
  const iv = strictBase64(value.iv, 'IV'); const tag = strictBase64(value.tag, 'tag'); const ciphertext = strictBase64(value.ciphertext, 'ciphertext');
  if (iv.length !== ivLength || tag.length !== tagLength) throw new TypeError('Invalid runtime-state JSON envelope lengths.');
  return { iv, tag, ciphertext };
}

export function decryptRuntimeState(path: string, encrypted: Uint8Array, keyHex: string | undefined = config.runtimeStateEncryptionKey): Uint8Array {
  const canonicalPath = validateRuntimeStatePath(path); const key = encryptionKey(keyHex);
  if (encrypted.byteLength > maximumStateBytes + 4_096) throw new RangeError('Runtime-state ciphertext is too large.');
  const envelope = envelopeParts(encrypted); const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv);
  decipher.setAAD(Buffer.from(canonicalPath, 'utf8')); decipher.setAuthTag(envelope.tag);
  try { return Uint8Array.from(Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])); }
  catch (error) { throw new Error('Runtime-state authentication failed.', { cause: error }); }
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new RangeError('Runtime-state response is too large.');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > maximum) throw new RangeError('Runtime-state response is too large.'); chunks.push(value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function createRuntimeState(options: RuntimeStateOptions): ExtensionState {
  const present = [options.url, options.key, options.bucket, options.encryptionKey].filter((value) => Boolean(value));
  if (present.length === 0) return Object.freeze({ configured: () => false, get: async () => null,
    put: async () => { throw new Error('Encrypted runtime state is not configured.'); },
    delete: async () => { throw new Error('Encrypted runtime state is not configured.'); } });
  if (present.length !== 4) throw new TypeError('Runtime state requires URL, key, bucket, and encryption key together.');
  const base = new URL(options.url!);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(base.hostname))) {
    throw new TypeError('Runtime-state URL must use HTTPS except on loopback.');
  }
  const timeoutMs = options.timeoutMs ?? 15_000; const maximum = options.maximumBytes ?? maximumStateBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumStateBytes) {
    throw new RangeError('Invalid runtime-state limits.');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const objectUrl = (path: string): URL => {
    const encoded = [options.bucket!, ...validateRuntimeStatePath(path).split('/')].map(encodeURIComponent).join('/');
    return new URL(`/storage/v1/object/${encoded}`, base);
  };
  const request = async (path: string, method: string, body?: Uint8Array): Promise<Response> => {
    const signal = AbortSignal.timeout(timeoutMs);
    return fetcher(objectUrl(path), { method, signal, redirect: 'error', headers: {
      authorization: `Bearer ${options.key!}`, apikey: options.key!, ...(body ? { 'content-type': 'application/octet-stream', 'x-upsert': 'true' } : {}),
    }, ...(body ? { body: Buffer.from(body) } : {}) });
  };
  return Object.freeze({
    configured: () => true,
    get: async (path: string) => { const response = await request(path, 'GET'); if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Runtime-state GET failed with status ${response.status}.`);
      return decryptRuntimeState(path, await boundedBytes(response, maximum + 4_096), options.encryptionKey); },
    put: async (path: string, plaintext: Uint8Array) => { if (plaintext.byteLength > maximum) throw new RangeError('Runtime-state plaintext is too large.');
      const response = await request(path, 'POST', encryptRuntimeState(path, plaintext, options.encryptionKey));
      if (!response.ok) throw new Error(`Runtime-state PUT failed with status ${response.status}.`); },
    delete: async (path: string) => { const response = await request(path, 'DELETE');
      if (!response.ok && response.status !== 404) throw new Error(`Runtime-state DELETE failed with status ${response.status}.`); },
  });
}

const defaultState = createRuntimeState(settingsOf());
export const getEncryptedRuntimeState = (path: string): Promise<Uint8Array | null> => defaultState.get(path);
export const putEncryptedRuntimeState = (path: string, plaintext: Uint8Array): Promise<void> => defaultState.put(path, plaintext);
export const deleteEncryptedRuntimeState = (path: string): Promise<void> => defaultState.delete(path);
