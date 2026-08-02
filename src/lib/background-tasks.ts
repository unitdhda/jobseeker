import { errorMessage } from './logging.ts';
import { hasPostgresDatabase, postgresQuery, withPostgresTransaction } from './postgres.ts';

const maximumPayloadBytes = 256 * 1024;
const defaultLeaseMs = 5 * 60_000;
const maximumLeaseMs = 60 * 60_000;
const maximumRetryDelayMs = 24 * 60 * 60_000;

export type BackgroundTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JsonObject = Record<string, unknown>;

export interface BackgroundTask {
  taskKey: string;
  kind: string;
  userId: string | null;
  state: BackgroundTaskState;
  payload: JsonObject;
  checkpoint: JsonObject;
  attempts: number;
  maxAttempts: number;
  serializationKey: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  availableAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface EnqueueBackgroundTaskInput {
  taskKey: string;
  kind: string;
  userId?: string | null;
  payload?: JsonObject;
  serializationKey?: string | null;
  maxAttempts?: number;
  availableAt?: Date;
}

interface TaskRow {
  task_key: string; kind: string; user_id: string | null; state: BackgroundTaskState;
  payload: JsonObject; checkpoint: JsonObject; attempts: number; max_attempts: number;
  serialization_key: string | null; lease_owner: string | null; lease_expires_at: Date | null;
  last_error: string | null; available_at: Date; created_at: Date; updated_at: Date; completed_at: Date | null;
}

const taskColumns = `task_key,kind,user_id,state,payload,checkpoint,attempts,max_attempts,serialization_key,
  lease_owner,lease_expires_at,last_error,available_at,created_at,updated_at,completed_at`;

function requirePostgres(): void {
  if (!hasPostgresDatabase()) throw new Error('Durable background tasks require DATABASE_URL.');
}
function boundedText(name: string, value: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${name} must contain 1-${maximum} printable characters.`);
  }
  return normalized;
}
function payloadJson(payload: JsonObject): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Task payload must be a JSON object.');
  let serialized: string;
  try { serialized = JSON.stringify(payload); }
  catch { throw new Error('Task payload must be JSON-serializable.'); }
  if (serialized === undefined || Buffer.byteLength(serialized) > maximumPayloadBytes) {
    throw new Error(`Task payload must not exceed ${maximumPayloadBytes} bytes.`);
  }
  return serialized;
}
function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}
function rowToTask(row: TaskRow): BackgroundTask {
  return { taskKey: row.task_key, kind: row.kind, userId: row.user_id, state: row.state, payload: row.payload,
    checkpoint: row.checkpoint, attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
    serializationKey: row.serialization_key, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error, availableAt: row.available_at, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at };
}
function leaseResource(serializationKey: string): string { return `task:${serializationKey}`; }
function validateWorkerId(workerId: string): string { return boundedText('workerId', workerId, 160); }
function validateLeaseMs(leaseMs: number): number { return positiveInteger('leaseMs', leaseMs, maximumLeaseMs); }

export function backgroundTaskRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer.');
  return Math.min(maximumRetryDelayMs, 5_000 * (2 ** Math.min(17, attempts - 1)));
}

export async function enqueueBackgroundTask(input: EnqueueBackgroundTaskInput): Promise<{ task: BackgroundTask; created: boolean }> {
  requirePostgres();
  const taskKey = boundedText('taskKey', input.taskKey, 240);
  const kind = boundedText('kind', input.kind, 100);
  const userId = input.userId == null ? null : boundedText('userId', input.userId, 160);
  const serializationKey = input.serializationKey === undefined
    ? (userId ? `user:${userId}` : null)
    : input.serializationKey == null ? null : boundedText('serializationKey', input.serializationKey, 220);
  const maxAttempts = positiveInteger('maxAttempts', input.maxAttempts ?? 5, 25);
  const availableAt = input.availableAt ?? new Date();
  if (!Number.isFinite(availableAt.getTime())) throw new Error('availableAt must be a valid date.');
  const serializedPayload = payloadJson(input.payload ?? {});
  const inserted = await postgresQuery<TaskRow>(`insert into background_tasks
    (task_key,kind,user_id,state,payload,max_attempts,available_at,serialization_key)
    values($1,$2,$3,'queued',$4::jsonb,$5,$6,$7) on conflict(task_key) do nothing returning ${taskColumns}`,
  [taskKey,kind,userId,serializedPayload,maxAttempts,availableAt,serializationKey]);
  if (inserted[0]) return { task: rowToTask(inserted[0]), created: true };
  const existing = (await postgresQuery<TaskRow & { payload_matches: boolean }>(`select ${taskColumns},
    payload=$2::jsonb payload_matches from background_tasks where task_key=$1`, [taskKey,serializedPayload]))[0];
  if (!existing) throw new Error('Task enqueue raced with deletion; retry.');
  const sameIdentity = existing.kind === kind && existing.user_id === userId && existing.serialization_key === serializationKey
    && existing.payload_matches;
  if (!sameIdentity) throw new Error('Task key is already used by a different task.');
  return { task: rowToTask(existing), created: false };
}

export async function getBackgroundTask(taskKey: string): Promise<BackgroundTask | null> {
  requirePostgres();
  const rows = await postgresQuery<TaskRow>(`select ${taskColumns} from background_tasks where task_key=$1`,
    [boundedText('taskKey',taskKey,240)]);
  return rows[0] ? rowToTask(rows[0]) : null;
}

export async function claimBackgroundTask(options: {
  workerId: string; kinds?: string[]; taskKey?: string; leaseMs?: number;
}): Promise<BackgroundTask | null> {
  requirePostgres();
  const workerId = validateWorkerId(options.workerId);
  const leaseMs = validateLeaseMs(options.leaseMs ?? defaultLeaseMs);
  const kinds = options.kinds ? [...new Set(options.kinds.map((kind) => boundedText('kind',kind,100)))] : null;
  const requestedKey = options.taskKey ? boundedText('taskKey',options.taskKey,240) : null;
  if ((!kinds?.length && !requestedKey) || (kinds && kinds.length>50)) {
    throw new Error('A taskKey or 1-50 task kinds must be provided.');
  }
  return withPostgresTransaction(async (client) => {
    await client.query('delete from coordination_leases where lease_expires_at<=now()');
    await client.query(`update background_tasks set state='failed',lease_owner=null,lease_expires_at=null,
      last_error='LeaseExpired',completed_at=now(),updated_at=now(),payload='{}'::jsonb
      where state='running' and lease_expires_at<=now() and attempts>=max_attempts`);
    const candidates = await client.query<TaskRow>(`select ${taskColumns} from background_tasks
      where ($1::text[] is null or kind=any($1)) and ($2::text is null or task_key=$2) and attempts<max_attempts and
        ((state='queued' and available_at<=now()) or (state='running' and lease_expires_at<=now()))
      order by available_at,created_at,task_key for update skip locked limit 50`, [kinds,requestedKey]);
    for (const candidate of candidates.rows) {
      const claimOwner = `${workerId}/${crypto.randomUUID()}`;
      const expiresAt = new Date(Date.now() + leaseMs);
      if (candidate.serialization_key) {
        const lease = await client.query(`insert into coordination_leases(resource_key,lease_owner,lease_expires_at,updated_at)
          values($1,$2,$3,now()) on conflict(resource_key) do update set lease_owner=excluded.lease_owner,
          lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
          where coordination_leases.lease_expires_at<=now() returning resource_key`,
        [leaseResource(candidate.serialization_key),claimOwner,expiresAt]);
        if (!lease.rowCount) continue;
      }
      const claimed = await client.query<TaskRow>(`update background_tasks set state='running',attempts=attempts+1,
        lease_owner=$2,lease_expires_at=$3,last_error=null,updated_at=now(),completed_at=null
        where task_key=$1 returning ${taskColumns}`, [candidate.task_key,claimOwner,expiresAt]);
      if (claimed.rows[0]) return rowToTask(claimed.rows[0]);
    }
    return null;
  });
}

export async function renewBackgroundTaskLease(taskKey: string, leaseOwner: string, leaseMs = defaultLeaseMs): Promise<Date> {
  requirePostgres();
  const key = boundedText('taskKey',taskKey,240); const owner = boundedText('leaseOwner',leaseOwner,220);
  const duration = validateLeaseMs(leaseMs); const expiresAt = new Date(Date.now() + duration);
  return withPostgresTransaction(async (client) => {
    const task = await client.query<Pick<TaskRow,'serialization_key'>>(`update background_tasks set lease_expires_at=$3,updated_at=now()
      where task_key=$1 and state='running' and lease_owner=$2 and lease_expires_at>now() returning serialization_key`,
    [key,owner,expiresAt]);
    if (!task.rows[0]) throw new Error('Background task lease was lost.');
    if (task.rows[0].serialization_key) {
      const lease = await client.query(`update coordination_leases set lease_expires_at=$3,updated_at=now()
        where resource_key=$1 and lease_owner=$2 and lease_expires_at>now()`,
      [leaseResource(task.rows[0].serialization_key),owner,expiresAt]);
      if (!lease.rowCount) throw new Error('Background task serialization lease was lost.');
    }
    return expiresAt;
  });
}

export async function saveBackgroundTaskCheckpoint(taskKey: string, leaseOwner: string, checkpoint: JsonObject): Promise<JsonObject> {
  requirePostgres();
  const serialized = payloadJson(checkpoint);
  const rows = await postgresQuery<{ checkpoint: JsonObject }>(`update background_tasks
    set checkpoint=checkpoint||$3::jsonb,updated_at=now() where task_key=$1 and state='running' and lease_owner=$2
    and lease_expires_at>now() returning checkpoint`,
  [boundedText('taskKey',taskKey,240),boundedText('leaseOwner',leaseOwner,220),serialized]);
  if (!rows[0]) throw new Error('Background task lease was lost.');
  return rows[0].checkpoint;
}

async function releaseSerializationLease(client: Parameters<Parameters<typeof withPostgresTransaction>[0]>[0],
  serializationKey: string | null, leaseOwner: string): Promise<void> {
  if (serializationKey) await client.query('delete from coordination_leases where resource_key=$1 and lease_owner=$2',
    [leaseResource(serializationKey),leaseOwner]);
}

export async function completeBackgroundTask(taskKey: string, leaseOwner: string, checkpoint?: JsonObject): Promise<void> {
  requirePostgres(); const serialized = checkpoint ? payloadJson(checkpoint) : null;
  await withPostgresTransaction(async (client) => {
    const rows = await client.query<Pick<TaskRow,'serialization_key'>>(`update background_tasks set state='completed',
      checkpoint=case when $3::jsonb is null then checkpoint else checkpoint||$3::jsonb end,payload='{}'::jsonb,
      lease_owner=null,lease_expires_at=null,last_error=null,completed_at=now(),updated_at=now()
      where task_key=$1 and state='running' and lease_owner=$2 and lease_expires_at>now() returning serialization_key`,
    [boundedText('taskKey',taskKey,240),boundedText('leaseOwner',leaseOwner,220),serialized]);
    if (!rows.rows[0]) throw new Error('Background task lease was lost.');
    await releaseSerializationLease(client,rows.rows[0].serialization_key,leaseOwner);
  });
}

export async function failBackgroundTask(taskKey: string, leaseOwner: string, error: unknown, options: {
  retryable?: boolean; retryAfterMs?: number;
} = {}): Promise<'queued' | 'failed'> {
  requirePostgres(); const key=boundedText('taskKey',taskKey,240); const owner=boundedText('leaseOwner',leaseOwner,220);
  const failure = errorMessage(error);
  return withPostgresTransaction(async (client) => {
    const current = await client.query<Pick<TaskRow,'attempts'|'max_attempts'|'serialization_key'>>(`select attempts,max_attempts,
      serialization_key from background_tasks where task_key=$1 and state='running' and lease_owner=$2
      and lease_expires_at>now() for update`, [key,owner]);
    const task = current.rows[0]; if (!task) throw new Error('Background task lease was lost.');
    const retry = (options.retryable ?? true) && Number(task.attempts)<Number(task.max_attempts);
    let delay = options.retryAfterMs ?? backgroundTaskRetryDelayMs(Number(task.attempts));
    if (!Number.isSafeInteger(delay) || delay<0 || delay>maximumRetryDelayMs) {
      throw new Error(`retryAfterMs must be an integer between 0 and ${maximumRetryDelayMs}.`);
    }
    await client.query(`update background_tasks set state=$3,available_at=case when $3='queued'
      then now()+($4::bigint*interval '1 millisecond') else available_at end,lease_owner=null,lease_expires_at=null,
      last_error=$5,completed_at=case when $3='failed' then now() else null end,payload=case when $3='failed'
      then '{}'::jsonb else payload end,updated_at=now() where task_key=$1 and lease_owner=$2`,
    [key,owner,retry?'queued':'failed',delay,failure]);
    await releaseSerializationLease(client,task.serialization_key,owner);
    return retry?'queued':'failed';
  });
}

export async function purgeFinishedBackgroundTasks(retentionDays = 7): Promise<number> {
  requirePostgres();
  if (!Number.isSafeInteger(retentionDays) || retentionDays<1 || retentionDays>365) {
    throw new Error('retentionDays must be an integer between 1 and 365.');
  }
  const rows = await postgresQuery<{ task_key: string }>(`delete from background_tasks where state in ('completed','failed','cancelled')
    and completed_at<now()-($1::int*interval '1 day') returning task_key`, [retentionDays]);
  return rows.length;
}
