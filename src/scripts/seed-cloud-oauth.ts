import { chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getEncryptedRuntimeState, putEncryptedRuntimeState } from '../runtime-state.ts';

const providerId = 'openai-codex';
const objectPath = 'oauth/codex.json';
const sourcePath = resolve(process.env.AI_AUTH_FILE ?? process.env.OPENAI_CODEX_AUTH_FILE ?? './auth/auth.json');
const source = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
await chmod(sourcePath, 0o600);
const credential = source[providerId] as Record<string, unknown> | undefined;
if (credential?.type !== 'oauth' || typeof credential.access !== 'string'
  || typeof credential.refresh !== 'string' || typeof credential.expires !== 'number') {
  throw new Error('Source OpenAI Codex OAuth credential is invalid.');
}
const existing = await getEncryptedRuntimeState(objectPath);
if (existing && process.env.OVERWRITE_CLOUD_OAUTH !== 'true') {
  throw new Error('Cloud OAuth state already exists; set OVERWRITE_CLOUD_OAUTH=true to replace it intentionally.');
}
await putEncryptedRuntimeState(objectPath, Buffer.from(`${JSON.stringify({ [providerId]: credential }, null, 2)}\n`));
console.info('OpenAI Codex OAuth credential was encrypted and uploaded to private runtime-state storage.');
