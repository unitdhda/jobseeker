import { createHash } from 'node:crypto';
import { CloudTasksClient, protos } from '@google-cloud/tasks';

let client: CloudTasksClient|undefined;

function required(name: string): string {
  const value=process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Cloud Tasks dispatch.`);
  return value;
}
function executionSecret(): string {
  const value=required('TASK_EXECUTION_SECRET');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new Error('TASK_EXECUTION_SECRET must contain 32-256 URL-safe characters.');
  }
  return value;
}
function taskId(taskKey: string): string {
  return `job-${createHash('sha256').update(taskKey).digest('base64url')}`;
}
function isAlreadyExists(error: unknown): boolean {
  return Boolean(error&&typeof error==='object'&&('code' in error)&&Number((error as { code: unknown }).code)===6);
}

export async function dispatchCloudTask(taskKey: string): Promise<'created'|'exists'> {
  const project=required('CLOUD_TASKS_PROJECT'); const location=required('CLOUD_TASKS_LOCATION');
  const queue=required('CLOUD_TASKS_QUEUE'); const workerUrl=required('CLOUD_TASKS_WORKER_URL').replace(/\/$/,'');
  const serviceAccountEmail=required('CLOUD_TASKS_SERVICE_ACCOUNT');
  const secret=executionSecret();
  const parent=`projects/${project}/locations/${location}/queues/${queue}`;
  const name=`${parent}/tasks/${taskId(taskKey)}`;
  const body=Buffer.from(JSON.stringify({ taskKey })).toString('base64');
  const task: protos.google.cloud.tasks.v2.ITask={ name,httpRequest:{
    httpMethod:protos.google.cloud.tasks.v2.HttpMethod.POST,
    url:`${workerUrl}/tasks/execute`,
    headers:{ 'Content-Type':'application/json','X-Task-Execution-Secret':secret },
    body,
    oidcToken:{ serviceAccountEmail,audience:process.env.CLOUD_TASKS_AUDIENCE?.trim()||workerUrl },
  } };
  try {
    client??=new CloudTasksClient();
    await client.createTask({ parent,task });
    return 'created';
  } catch (error) {
    if (isAlreadyExists(error)) return 'exists';
    throw error;
  }
}

export async function closeCloudTasksClient(): Promise<void> {
  const current=client; client=undefined; await current?.close();
}
