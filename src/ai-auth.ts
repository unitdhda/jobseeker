/**
 * The app-owned credential store pi-ai resolves auth through. One document keyed by provider id — the auth.json
 * shape — held either in the encrypted cloud runtime state (when configured) or in a local file. A stored
 * credential owns its provider; pi-ai consults provider env variables (OPENAI_API_KEY and friends) only when
 * nothing is stored, so the operator chooses env or auth.json per provider without any code knowing which.
 *
 * OAuth refresh runs inside `modify`, so writes are serialized per provider in-process (promise chain) and
 * cross-process (Postgres advisory lock) — two replicas can never double-refresh a rotated token.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { getEncryptedRuntimeState, putEncryptedRuntimeState } from './runtime-state.ts';
import { withPostgresAdvisoryLock } from './postgres.ts';

// The cloud object predates the generalized store and already holds a provider-keyed document; renaming it would
// orphan deployed credentials.
const cloudDocumentPath = 'oauth/codex.json';

function filePath(): string {
  return resolve(process.env.AI_AUTH_FILE ?? process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
}

function usesCloudStore(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    && process.env.SUPABASE_STORAGE_BUCKET && process.env.RUNTIME_STATE_ENCRYPTION_KEY);
}

async function readDocument(): Promise<Record<string, Credential>> {
  if (usesCloudStore()) {
    const encrypted = await getEncryptedRuntimeState(cloudDocumentPath);
    if (!encrypted) return {};
    try { return JSON.parse(Buffer.from(encrypted).toString('utf8')) as Record<string, Credential>; }
    catch (error) { throw new Error('AI credential cloud document is invalid.', { cause: error }); }
  }
  try {
    const document = JSON.parse(await readFile(filePath(), 'utf8')) as Record<string, Credential>;
    await chmod(filePath(), 0o600).catch(() => undefined);
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`AI credential file at ${filePath()} is unreadable.`, { cause: error });
  }
}

async function writeDocument(document: Record<string, Credential>): Promise<void> {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (usesCloudStore()) {
    await putEncryptedRuntimeState(cloudDocumentPath, Buffer.from(serialized));
    return;
  }
  const path = filePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, path);
}

export function createCredentialStore(): CredentialStore {
  const chains = new Map<string, Promise<unknown>>();
  const enqueue = <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
    const next = (chains.get(providerId) ?? Promise.resolve()).then(task, task);
    chains.set(providerId, next.catch(() => undefined));
    return next;
  };
  return {
    async read(providerId: string): Promise<Credential | undefined> {
      return (await readDocument())[providerId];
    },
    async list(): Promise<readonly CredentialInfo[]> {
      return Object.entries(await readDocument()).map(([providerId, credential]) =>
        ({ providerId, type: credential.type }));
    },
    modify(providerId, fn): Promise<Credential | undefined> {
      return enqueue(providerId, () => withPostgresAdvisoryLock(`jobseeker-ai-auth:${providerId}`, async () => {
        const document = await readDocument();
        const updated = await fn(document[providerId]);
        if (updated === undefined) return document[providerId];
        document[providerId] = updated;
        await writeDocument(document);
        return updated;
      }));
    },
    async delete(providerId: string): Promise<void> {
      await enqueue(providerId, () => withPostgresAdvisoryLock(`jobseeker-ai-auth:${providerId}`, async () => {
        const document = await readDocument();
        if (providerId in document) { delete document[providerId]; await writeDocument(document); }
        return undefined;
      }));
    },
  };
}
