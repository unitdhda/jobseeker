import { config } from '../config.ts';
import { ensureCvAndSearchProfiles } from '../lib/workflows.ts';
import { startScriptRuntime } from './runtime.ts';

const flue = await startScriptRuntime();
try {
  if (!config.telegramUserId) throw new Error('TELEGRAM_USER_ID is required.');
  const profiles = await ensureCvAndSearchProfiles(config.telegramUserId, true);
  console.log(`Prepared ${Object.keys(profiles).length} platform search profiles.`);
} finally {
  await Promise.race([flue.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}
process.exit(0);
