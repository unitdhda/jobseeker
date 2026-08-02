import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const project=process.env.GCP_PROJECT_ID;
if (!project) throw new Error('GCP_PROJECT_ID is required.');
const rotate=process.env.ROTATE_GCP_SECRETS==='true';
const generatedTaskSecret=randomBytes(32).toString('base64url');
const values=new Map([
  ['jobseeker-database-url',process.env.DATABASE_URL],
  ['jobseeker-telegram-bot-token',process.env.TELEGRAM_BOT_TOKEN],
  ['jobseeker-telegram-webhook-secret',process.env.TELEGRAM_WEBHOOK_SECRET],
  ['jobseeker-task-execution-secret',process.env.TASK_EXECUTION_SECRET||generatedTaskSecret],
  ['jobseeker-supabase-secret-key',process.env.SUPABASE_SECRET_KEY],
  ['jobseeker-runtime-state-encryption-key',process.env.RUNTIME_STATE_ENCRYPTION_KEY],
]);
function gcloud(args,{ input,quiet=false }={}) {
  const result=spawnSync('gcloud',[...args,'--project',project,...(quiet?['--quiet']:[])],{
    input,encoding:'utf8',stdio:input===undefined?'pipe':['pipe','pipe','inherit'],
  });
  if (result.error) throw result.error;
  if (result.status!==0) throw new Error(result.stderr?.trim()||`gcloud exited with ${result.status}`);
  return result.stdout.trim();
}
function hasEnabledVersion(secret) {
  return Boolean(gcloud(['secrets','versions','list',secret,'--filter=state=ENABLED','--format=value(name)']).trim());
}
for (const [secret,value] of values) {
  if (!value) throw new Error(`A local value for ${secret} is missing.`);
  if ((secret.endsWith('webhook-secret')||secret.endsWith('execution-secret'))&&!/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new Error(`${secret} must contain 32-256 URL-safe characters.`);
  }
  if (!rotate&&hasEnabledVersion(secret)) {
    console.info(`${secret}: existing enabled version retained`);
    continue;
  }
  gcloud(['secrets','versions','add',secret,'--data-file=-'],{ input:value,quiet:true });
  console.info(`${secret}: version added`);
}
console.info('GCP secret seeding completed without printing secret values.');
