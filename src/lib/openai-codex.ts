import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { OAuthCredential, Provider } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

const providerId = 'openai-codex';
let refreshInFlight: Promise<OAuthCredential> | undefined;

function authPath(): string {
  return resolve(process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
}

async function readCredential(): Promise<OAuthCredential> {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(await readFile(authPath(), 'utf8')) as Record<string, unknown>;
    await chmod(authPath(), 0o600);
  } catch (error) {
    throw new Error(`OpenAI Codex OAuth is not configured at ${authPath()}.`, { cause: error });
  }
  const credential = document[providerId] as Partial<OAuthCredential> | undefined;
  if (credential?.type !== 'oauth' || !credential.access || !credential.refresh || !credential.expires) {
    throw new Error(`OpenAI Codex OAuth credential is missing from ${authPath()}.`);
  }
  return credential as OAuthCredential;
}

async function persistCredential(credential: OAuthCredential): Promise<void> {
  const path = authPath();
  let document: Record<string, unknown> = {};
  try {
    document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {}
  document[providerId] = credential;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function validCredential(source: Provider): Promise<OAuthCredential> {
  const credential = await readCredential();
  if (credential.expires > Date.now() + 60_000) return credential;
  const oauth = source.auth.oauth;
  if (!oauth) throw new Error('OpenAI Codex provider has no OAuth implementation.');
  refreshInFlight ??= oauth.refresh(credential).then(async (refreshed) => {
    await persistCredential(refreshed);
    return refreshed;
  }).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

export function registerOpenAICodexFileProvider(): void {
  const source = openaiCodexProvider();
  const oauth = source.auth.oauth;
  if (!oauth) throw new Error('OpenAI Codex provider has no OAuth implementation.');
  setProvider({
    ...source,
    auth: {
      apiKey: {
        name: 'OpenAI Codex OAuth file',
        async resolve() {
          const credential = await validCredential(source);
          return { auth: await oauth.toAuth(credential), source: 'OpenAI Codex OAuth' };
        },
      },
    },
  });
}
