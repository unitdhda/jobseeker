import { randomBytes } from 'node:crypto';
import type { UserId } from '@jobseeker/engine/contracts';
import { currentStoreRuntime, postgresQuery } from './client.ts';

const maximumSessionTtlMs = 30 * 86_400_000;
const cleanupTimes = new Map<symbol, number>();

function validKind(kind: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(kind)) {
    throw new TypeError('Invalid session kind: expected lowercase alphanumeric/hyphen identifier.');
  }
}

function validTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > maximumSessionTtlMs) {
    throw new RangeError('Invalid session TTL: expected 1,000 ms through 30 days.');
  }
}

function validUpdateId(updateId: number): void {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new RangeError('Invalid Telegram update ID: expected a nonnegative safe integer.');
  }
}

export async function getTelegramSession<TResult>(userId: UserId, kind: string): Promise<TResult | null> {
  validKind(kind);
  const result = await postgresQuery<{ state: TResult }>(
    'select state from user_state where user_id=$1 and kind=$2 and expires_at>now()', [userId, kind]);
  return result.rows[0]?.state ?? null;
}

export async function setTelegramSession(
  userId: UserId, kind: string, state: unknown, ttlMs: number,
): Promise<void> {
  validKind(kind); validTtl(ttlMs);
  await postgresQuery(`insert into user_state(user_id,kind,state,token,expires_at)
      values($1,$2,$3::jsonb,null,now()+($4*interval '1 millisecond'))
    on conflict(user_id,kind) do update set state=excluded.state,token=null,
      expires_at=excluded.expires_at,updated_at=now()`, [userId, kind, JSON.stringify(state), ttlMs]);
}

export interface SessionClaim<TResult> {
  readonly claimed: boolean;
  readonly expiresAt: Date;
  readonly state: TResult;
  readonly token?: string;
}

async function claimSession<TResult extends Record<string, unknown>>(
  userId: UserId, kind: string, state: TResult, ttlMs: number, attempt: number,
): Promise<SessionClaim<TResult>> {
  const token = randomBytes(32).toString('hex');
  // Durable workflow state exposes the same token required by token-owned renew/release; _claimToken remains legacy-compatible.
  const claimedState = { ...state, token, _claimToken: token };
  const result = await postgresQuery<{ state: TResult; expires_at: Date | string }>(`insert into user_state(user_id,kind,state,token,expires_at)
      values($1,$2,$3::jsonb,$4,now()+($5*interval '1 millisecond'))
    on conflict(user_id,kind) do update set state=excluded.state,token=excluded.token,
      expires_at=excluded.expires_at,updated_at=now()
      where user_state.expires_at<=now()
    returning state,expires_at`, [userId, kind, JSON.stringify(claimedState), token, ttlMs]);
  if (result.rows[0]) return Object.freeze({
    claimed: true, expiresAt: new Date(result.rows[0].expires_at), state: result.rows[0].state, token,
  });

  const current = await postgresQuery<{ state: TResult; expires_at: Date | string }>(
    'select state,expires_at from user_state where user_id=$1 and kind=$2 and expires_at>now()', [userId, kind]);
  if (!current.rows[0] && attempt === 0) {
    // A release can win between failed upsert and live-state read; retry that narrow race once.
    return claimSession(userId, kind, state, ttlMs, 1);
  }
  if (!current.rows[0]) throw new Error('Session claim race could not be resolved.');
  return Object.freeze({ claimed: false, expiresAt: new Date(current.rows[0].expires_at), state: current.rows[0].state });
}

export function claimTelegramSession<TResult extends Record<string, unknown>>(
  userId: UserId, kind: string, state: TResult, ttlMs: number,
): Promise<SessionClaim<TResult>> {
  validKind(kind); validTtl(ttlMs);
  return claimSession(userId, kind, state, ttlMs, 0);
}

export async function updateClaimedTelegramSession(
  userId: UserId, kind: string, token: string, state: Record<string, unknown>, ttlMs: number,
): Promise<boolean> {
  validKind(kind); validTtl(ttlMs);
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new TypeError('Invalid session claim token.');
  const result = await postgresQuery(`update user_state set state=$4::jsonb,
      expires_at=now()+($5*interval '1 millisecond'),updated_at=now()
    where user_id=$1 and kind=$2 and token=$3 and expires_at>now()`, [
    userId, kind, token, JSON.stringify({ ...state, _claimToken: token }), ttlMs,
  ]);
  return (result.rowCount ?? 0) === 1;
}

export async function releaseClaimedTelegramSession(userId: UserId, kind: string, token: string): Promise<boolean> {
  validKind(kind);
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new TypeError('Invalid session claim token.');
  const result = await postgresQuery('delete from user_state where user_id=$1 and kind=$2 and token=$3', [userId, kind, token]);
  return (result.rowCount ?? 0) === 1;
}

export async function deleteTelegramSession(userId: UserId, kind: string): Promise<void> {
  validKind(kind);
  await postgresQuery('delete from user_state where user_id=$1 and kind=$2', [userId, kind]);
}

async function opportunisticUpdateCleanup(): Promise<void> {
  const runtime = currentStoreRuntime();
  const now = Date.now();
  if (now - (cleanupTimes.get(runtime.id) ?? 0) < 3_600_000) return;
  cleanupTimes.set(runtime.id, now);
  void postgresQuery("delete from telegram_updates where received_at<now()-interval '7 days'").catch(() => undefined);
}

export async function claimTelegramUpdate(updateId: number, retryProcessing = false): Promise<boolean> {
  validUpdateId(updateId);
  const inserted = await postgresQuery(`insert into telegram_updates(update_id,state,attempts,lease_expires_at)
    values($1,'processing',1,now()+interval '5 minutes') on conflict(update_id) do nothing returning update_id`, [updateId]);
  let claimed = (inserted.rowCount ?? 0) === 1;
  if (!claimed && retryProcessing) {
    const reclaimed = await postgresQuery(`update telegram_updates set state='processing',attempts=attempts+1,
        lease_expires_at=now()+interval '5 minutes',error_class=null,updated_at=now()
      where update_id=$1 and (state='failed' or (state='processing' and lease_expires_at<=now()))
      returning update_id`, [updateId]);
    claimed = (reclaimed.rowCount ?? 0) === 1;
  }
  await opportunisticUpdateCleanup();
  return claimed;
}

export async function completeTelegramUpdate(updateId: number): Promise<boolean> {
  validUpdateId(updateId);
  const result = await postgresQuery(`update telegram_updates set state='completed',lease_expires_at=null,
    completed_at=now(),updated_at=now() where update_id=$1 and state='processing'`, [updateId]);
  return (result.rowCount ?? 0) === 1;
}

export async function failTelegramUpdate(updateId: number, error: unknown): Promise<boolean> {
  validUpdateId(updateId);
  const errorClass = (error instanceof Error ? error.name : typeof error).slice(0, 120);
  const result = await postgresQuery(`update telegram_updates set state='failed',lease_expires_at=null,
    error_class=$2,updated_at=now() where update_id=$1 and state='processing'`, [updateId, errorClass]);
  return (result.rowCount ?? 0) === 1;
}
