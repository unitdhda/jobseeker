import type { JobseekerExtensionApi } from '../extension-api.ts';
import { claudeCliProvider } from './claude-bridge.ts';

function positive(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError(`Invalid Claude CLI ${name}.`);
  return parsed;
}

export default function register(api: JobseekerExtensionApi): void {
  api.registerAiProvider(claudeCliProvider({
    executablePath: api.env.CLAUDE_CLI_PATH?.trim() || 'claude',
    cwd: api.env.CLAUDE_CLI_CWD?.trim() || undefined,
    defaultTimeoutMs: positive(api.env.CLAUDE_CLI_TIMEOUT_MS, 300_000, 'timeout'),
    endpoint: api.env.CLAUDE_CLI_ENDPOINT?.trim() || undefined,
    endpointToken: api.env.CLAUDE_CLI_TOKEN,
    environment: api.env,
  }));
}
