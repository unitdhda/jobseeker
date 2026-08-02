import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createModels, type Models, type OAuthCredential, type Provider } from '@earendil-works/pi-ai';
import { getEncryptedRuntimeState, putEncryptedRuntimeState } from './encrypted-state-store.ts';
import { hasPostgresDatabase, withPostgresTransaction } from './postgres.ts';

const providerId = 'openai-codex';
const cloudAuthPath = 'oauth/codex.json';
let refreshInFlight: Promise<OAuthCredential> | undefined;

function authPath(): string {
  return resolve(process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
}

function usesCloudCredentialStore(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    && process.env.SUPABASE_STORAGE_BUCKET && process.env.RUNTIME_STATE_ENCRYPTION_KEY);
}

async function readDocument(): Promise<Record<string, unknown>> {
  if (usesCloudCredentialStore()) {
    const encrypted = await getEncryptedRuntimeState(cloudAuthPath);
    if (!encrypted) throw new Error('OpenAI Codex OAuth is not configured in encrypted cloud storage.');
    try { return JSON.parse(Buffer.from(encrypted).toString('utf8')) as Record<string, unknown>; }
    catch (error) { throw new Error('OpenAI Codex OAuth cloud document is invalid.', { cause: error }); }
  }
  try {
    const document = JSON.parse(await readFile(authPath(), 'utf8')) as Record<string, unknown>;
    await chmod(authPath(), 0o600);
    return document;
  } catch (error) {
    throw new Error(`OpenAI Codex OAuth is not configured at ${authPath()}.`, { cause: error });
  }
}

async function readCredential(): Promise<OAuthCredential> {
  const credential = (await readDocument())[providerId] as Partial<OAuthCredential> | undefined;
  if (credential?.type !== 'oauth' || !credential.access || !credential.refresh || !credential.expires) {
    throw new Error('OpenAI Codex OAuth credential is missing.');
  }
  return credential as OAuthCredential;
}

async function persistCredential(credential: OAuthCredential): Promise<void> {
  const document: Record<string, unknown> = await readDocument().catch(() => ({}));
  document[providerId] = credential;
  if (usesCloudCredentialStore()) {
    await putEncryptedRuntimeState(cloudAuthPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
    return;
  }
  const path = authPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function refreshCredential(source: Provider): Promise<OAuthCredential> {
  const refresh = async (): Promise<OAuthCredential> => {
    const current = await readCredential();
    if (current.expires > Date.now() + 60_000) return current;
    const oauth = source.auth.oauth;
    if (!oauth) throw new Error('OpenAI Codex provider has no OAuth implementation.');
    const refreshed = await oauth.refresh(current);
    await persistCredential(refreshed);
    return refreshed;
  };
  if (!hasPostgresDatabase()) return refresh();
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('jobseeker-openai-codex-refresh'))");
    return refresh();
  });
}

async function validCredential(source: Provider): Promise<OAuthCredential> {
  const credential = await readCredential();
  if (credential.expires > Date.now() + 60_000) return credential;
  refreshInFlight ??= refreshCredential(source).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

let configuredModels: Models | undefined;

export function aiModels(): Models {
  if (configuredModels) return configuredModels;
  const models=createModels();
  models.setProvider(openaiProvider());
  const source=openaiCodexProvider(),oauth=source.auth.oauth;
  if(!oauth)throw new Error('OpenAI Codex provider has no OAuth implementation.');
  models.setProvider({...source,auth:{apiKey:{name:'OpenAI Codex OAuth',async resolve(){
    const credential=await validCredential(source);
    return {auth:await oauth.toAuth(credential),source:'OpenAI Codex OAuth'};
  }}}});
  configuredModels=models;
  return models;
}
