import { createHash } from 'node:crypto';
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import { config } from './config.ts';
import { approvedUsers } from './database.ts';
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate } from './telegram-state.ts';
import { mapConcurrent } from './concurrency.ts';

export type CloudTaskRequest =
  | { key: string; kind: 'telegram'; update: unknown }
  | { key: string; kind: 'alerts' | 'digest'; userId: string };

let client: CloudTasksClient | undefined;
const dispatchBucketMs = 30 * 60_000;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Cloud Tasks dispatch.`);
  return value;
}

function executionSecret(): string {
  const value = required('TASK_EXECUTION_SECRET');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('TASK_EXECUTION_SECRET is invalid.');
  return value;
}

function taskId(key: string): string {
  return `job-${createHash('sha256').update(key).digest('base64url')}`;
}

function alreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && Number((error as { code: unknown }).code) === 6);
}

async function dispatch(request: CloudTaskRequest): Promise<boolean> {
  const project = required('CLOUD_TASKS_PROJECT');
  const location = required('CLOUD_TASKS_LOCATION');
  const queue = required('CLOUD_TASKS_QUEUE');
  const workerUrl = required('CLOUD_TASKS_WORKER_URL').replace(/\/$/, '');
  const serviceAccountEmail = required('CLOUD_TASKS_SERVICE_ACCOUNT');
  const parent = `projects/${project}/locations/${location}/queues/${queue}`;
  const task: protos.google.cloud.tasks.v2.ITask = {
    name: `${parent}/tasks/${taskId(request.key)}`,
    dispatchDeadline: { seconds: 1_800 },
    httpRequest: {
      httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
      url: `${workerUrl}/tasks/execute`,
      headers: { 'Content-Type': 'application/json', 'X-Task-Execution-Secret': executionSecret() },
      body: Buffer.from(JSON.stringify(request)).toString('base64'),
      oidcToken: { serviceAccountEmail, audience: process.env.CLOUD_TASKS_AUDIENCE?.trim() || workerUrl },
    },
  };
  try {
    client ??= new CloudTasksClient();
    await client.createTask({ parent, task });
    return true;
  } catch (error) {
    if (alreadyExists(error)) return false;
    throw error;
  }
}

function updateId(update: unknown): number {
  const value = Number((update as { update_id?: unknown } | null)?.update_id);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Telegram update_id is invalid.');
  return value;
}

export async function enqueueTelegramUpdateTask(update: unknown, id: number): Promise<boolean> {
  if (updateId(update) !== id) throw new Error('Telegram update_id does not match the queued task.');
  return dispatch({ key: `telegram:${id}`, kind: 'telegram', update });
}

export async function enqueueDueDeliveryTasks(now = new Date()): Promise<number> {
  const {isDigestDue,isWithinDeliveryWindow}=await import('./vacancies/jobs.ts');
  const bucket = Math.floor(now.getTime() / dispatchBucketMs);
  const requests: CloudTaskRequest[] = [];
  for (const user of await approvedUsers()) {
    if (await isWithinDeliveryWindow(user.userId, now)) {
      requests.push({ key: `alerts:${user.userId}:${bucket}`, kind: 'alerts', userId: user.userId });
    }
    if (await isDigestDue(user.userId, now)) {
      requests.push({ key: `digest:${user.userId}:${bucket}`, kind: 'digest', userId: user.userId });
    }
  }
  await mapConcurrent(requests, config.deliveryConcurrency, dispatch);
  return requests.length;
}

export async function handleCloudTask(request: CloudTaskRequest): Promise<void> {
  const {handleTelegramWebhookUpdate,sendDailyDigest,sendPendingAlerts}=await import('./telegram.ts');
  const {isDigestDue,isWithinDeliveryWindow}=await import('./vacancies/jobs.ts');
  if (!request || typeof request.key !== 'string' || request.key.length < 1 || request.key.length > 240) {
    throw new Error('Cloud Task key is invalid.');
  }
  if (request.kind === 'telegram') {
    const id = updateId(request.update);
    if (request.key !== `telegram:${id}`) throw new Error('Telegram task key is invalid.');
    if (!await claimTelegramUpdate(id, true)) return;
    try {
      await handleTelegramWebhookUpdate(request.update);
      await completeTelegramUpdate(id);
    } catch (error) {
      await failTelegramUpdate(id, error).catch(() => undefined);
      throw error;
    }
    return;
  }
  if (typeof request.userId !== 'string' || !request.userId || request.key.split(':')[1] !== request.userId) {
    throw new Error('Delivery task user is invalid.');
  }
  const now = new Date();
  if (request.kind === 'alerts') {
    if (await isWithinDeliveryWindow(request.userId, now)) await sendPendingAlerts(request.userId);
    return;
  }
  if (request.kind === 'digest') {
    if (!await isDigestDue(request.userId, now)) return;
    await sendDailyDigest(request.userId,{scheduled:true});
    return;
  }
  throw new Error('Cloud Task kind is invalid.');
}

export async function closeCloudTasksClient(): Promise<void> {
  const current = client;
  client = undefined;
  await current?.close();
}
