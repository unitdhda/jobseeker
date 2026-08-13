import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import type { ExtensionState } from './extensions.ts';

const maximumCredentialBytes = 1024 * 1024;
const credentialObjectPath = 'oauth/codex.json';
const providerIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
type CredentialDocument = Record<string, Credential>;

export interface CredentialStoreOptions {
  readonly state: ExtensionState;
  readonly filePath: string;
  readonly withAdvisoryLock: <TResult>(key: string, operation: () => Promise<TResult>) => Promise<TResult>;
}

function providerId(value: string): string {
  if (!providerIdPattern.test(value)) throw new TypeError('Invalid AI credential provider ID.');
  return value;
}
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid API credential environment.');
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !key || typeof item !== 'string')) throw new TypeError('Invalid API credential environment.');
  return Object.fromEntries(entries);
}
function parseCredential(value: unknown): Credential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AI credential document.');
  const record = value as Record<string, unknown>;
  if (record.type === 'api_key') {
    if (Object.keys(record).some((key) => !['type', 'key', 'env'].includes(key))
      || (record.key !== undefined && typeof record.key !== 'string')) throw new TypeError('Invalid API-key credential.');
    return { type: 'api_key', ...(record.key !== undefined ? { key: record.key } : {}),
      ...(record.env !== undefined ? { env: stringRecord(record.env) } : {}) };
  }
  if (record.type === 'oauth') {
    if (typeof record.refresh !== 'string' || typeof record.access !== 'string' || !Number.isFinite(record.expires)) {
      throw new TypeError('Invalid OAuth credential.');
    }
    // OAuth providers may persist provider-specific rotation metadata; JSON parsing already excludes executable values.
    return { ...record, type: 'oauth', refresh: record.refresh, access: record.access, expires: record.expires as number };
  }
  throw new TypeError('Invalid AI credential type.');
}
function parseDocument(bytes: Uint8Array | null): CredentialDocument {
  if (bytes === null || bytes.byteLength === 0) return Object.create(null) as CredentialDocument;
  if (bytes.byteLength > maximumCredentialBytes) throw new RangeError('AI credential document is too large.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TypeError('Invalid AI credential JSON.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Invalid AI credential document.');
  const result = Object.create(null) as CredentialDocument;
  for (const [key, value] of Object.entries(parsed)) result[providerId(key)] = parseCredential(value);
  return result;
}
export function parseCredentialDocument(value: unknown): Readonly<Record<string, Credential>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AI credential document.');
  const result = Object.create(null) as CredentialDocument;
  for (const [key, credential] of Object.entries(value)) result[providerId(key)] = parseCredential(credential);
  return Object.freeze(result);
}

function bytesOf(document: CredentialDocument): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  if (bytes.byteLength > maximumCredentialBytes) throw new RangeError('AI credential document is too large.');
  return bytes;
}
function cloneCredential(value: Credential | undefined): Credential | undefined {
  return value === undefined ? undefined : parseCredential(JSON.parse(JSON.stringify(value)));
}

async function readLocal(path: string): Promise<Uint8Array | null> {
  try { const value = await readFile(path); return Uint8Array.from(value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function writeLocal(path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); await chmod(path, 0o600); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  if (!options.filePath.trim()) throw new TypeError('AI credential file path must be nonempty.');
  if (typeof options.withAdvisoryLock !== 'function') throw new TypeError('AI credential store requires an advisory lock.');
  let chain: Promise<void> = Promise.resolve();
  const enqueue = <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
    const result = chain.then(operation, operation);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async (): Promise<CredentialDocument> => parseDocument(options.state.configured()
    ? await options.state.get(credentialObjectPath) : await readLocal(options.filePath));
  const save = async (document: CredentialDocument): Promise<void> => {
    const bytes = bytesOf(document);
    if (options.state.configured()) await options.state.put(credentialObjectPath, bytes);
    else await writeLocal(options.filePath, bytes);
  };
  const locked = <TResult>(operation: () => Promise<TResult>): Promise<TResult> => enqueue(() =>
    options.withAdvisoryLock('jobseeker-ai-credentials', operation));

  return Object.freeze({
    read: async (provider: string) => {
      const id = providerId(provider);
      return locked(async () => cloneCredential((await load())[id]));
    },
    list: () => locked(async () => Object.freeze(Object.entries(await load()).map(([id, credential]) => Object.freeze({
      providerId: id, type: credential.type,
    } satisfies CredentialInfo)).sort((left, right) => left.providerId.localeCompare(right.providerId)))),
    modify: (provider: string, modify: (current: Credential | undefined) => Promise<Credential | undefined>) => locked(async () => {
      const id = providerId(provider); const document = await load(); const current = cloneCredential(document[id]);
      const replacement = await modify(current); if (replacement === undefined) return cloneCredential(document[id]);
      document[id] = parseCredential(replacement); await save(document); return cloneCredential(document[id]);
    }),
    delete: (provider: string) => locked(async () => {
      const id = providerId(provider); const document = await load();
      if (!(id in document)) return; delete document[id]; await save(document);
    }),
  });
}
