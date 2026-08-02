import { config } from '../config.ts';
import { ensureCvAndSearchProfiles } from '../workflows.ts';

if (!config.telegramUserId) throw new Error('TELEGRAM_USER_ID is required.');
const profiles=await ensureCvAndSearchProfiles(config.telegramUserId,true);
console.log(`Prepared ${Object.keys(profiles).length} platform search profiles.`);
process.exit(0);
