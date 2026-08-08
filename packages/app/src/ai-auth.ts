/**
 * The app-owned credential store pi-ai resolves auth through. One document keyed by provider id — the auth.json
 * shape — held either in the encrypted remote runtime state (when configured) or in a local file. A stored
 * credential owns its provider; pi-ai consults provider env variables (OPENAI_API_KEY and friends) only when
 * nothing is stored, so the operator chooses env or auth.json per provider without any code knowing which.
 *
 * OAuth refresh runs inside `modify`. The store is one document read and rewritten whole, so every write
 * serializes on one in-process chain and one cross-process Postgres advisory lock: provider-scoped locking would
 * let two providers' concurrent read-modify-write cycles silently drop each other's credentials.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { getEncryptedRuntimeState, putEncryptedRuntimeState, runtimeStateConfigured } from './runtime-state.ts';
import { withPostgresAdvisoryLock } from './postgres.ts';

// The stored object predates the generalized store and already holds a provider-keyed document; renaming it would
// orphan deployed credentials.
const remoteDocumentPath = 'oauth/codex.json';

function filePath(): string {
  return resolve(process.env.AI_AUTH_FILE ?? process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
}

// One definition of "configured", shared with the runtime-state module: a partial configuration must never make
// this store silently fall back to a local file that the next container recreation discards.
const usesRemoteStore = runtimeStateConfigured;

async function readDocument(): Promise<Record<string, Credential>> {
  if (usesRemoteStore()) {
    const encrypted = await getEncryptedRuntimeState(remoteDocumentPath);
    if (!encrypted) return {};
    try { return JSON.parse(Buffer.from(encrypted).toString('utf8')) as Record<string, Credential>; }
    catch (error) { throw new Error('The stored AI credential document is invalid.', { cause: error }); }
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
  if (usesRemoteStore()) {
    await putEncryptedRuntimeState(remoteDocumentPath, Buffer.from(serialized));
    return;
  }
  const path = filePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, path);
}

const documentLockKey = 'jobseeker-ai-auth';

export function createCredentialStore(): CredentialStore {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
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
      return enqueue(() => withPostgresAdvisoryLock(documentLockKey, async () => {
        const document = await readDocument();
        const updated = await fn(document[providerId]);
        if (updated === undefined) return document[providerId];
        document[providerId] = updated;
        await writeDocument(document);
        return updated;
      }));
    },
    async delete(providerId: string): Promise<void> {
      await enqueue(() => withPostgresAdvisoryLock(documentLockKey, async () => {
        const document = await readDocument();
        if (providerId in document) { delete document[providerId]; await writeDocument(document); }
        return undefined;
      }));
    },
  };
}
