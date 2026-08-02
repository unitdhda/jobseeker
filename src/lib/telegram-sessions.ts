import { hasPostgresDatabase, postgresQuery } from './postgres.ts';

interface LocalSession { state: unknown; expiresAt: number }
const localSessions = new Map<string, LocalSession>();
const key = (userId: string, kind: string): string => `${userId}\0${kind}`;

function validKind(kind: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) throw new Error('Telegram session kind is invalid.');
}
function expiry(ttlMs: number): Date {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 86_400_000) throw new Error('Telegram session TTL is invalid.');
  return new Date(Date.now() + ttlMs);
}

export async function getTelegramSession<T>(userId: string, kind: string): Promise<T | null> {
  validKind(kind);
  if (!hasPostgresDatabase()) {
    const session = localSessions.get(key(userId, kind));
    if (!session || session.expiresAt <= Date.now()) { localSessions.delete(key(userId, kind)); return null; }
    return session.state as T;
  }
  const rows = await postgresQuery<{ state: T }>(`select state from telegram_sessions
    where user_id=$1 and kind=$2 and expires_at>now()`, [userId, kind]);
  return rows[0]?.state ?? null;
}

export async function setTelegramSession(userId: string, kind: string, state: unknown, ttlMs: number): Promise<void> {
  validKind(kind); const expiresAt = expiry(ttlMs);
  if (!hasPostgresDatabase()) { localSessions.set(key(userId, kind), { state, expiresAt: expiresAt.getTime() }); return; }
  await postgresQuery(`insert into telegram_sessions(user_id,kind,state,expires_at,updated_at) values($1,$2,$3::jsonb,$4,now())
    on conflict(user_id,kind) do update set state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    [userId, kind, JSON.stringify(state), expiresAt]);
}

export async function claimTelegramSession(userId: string, kind: string, state: unknown, ttlMs: number): Promise<{ claimed: boolean; expiresAt: Date }> {
  validKind(kind); const expiresAt = expiry(ttlMs);
  if (!hasPostgresDatabase()) {
    const current = localSessions.get(key(userId, kind));
    if (current && current.expiresAt > Date.now()) return { claimed: false, expiresAt: new Date(current.expiresAt) };
    localSessions.set(key(userId, kind), { state, expiresAt: expiresAt.getTime() }); return { claimed: true, expiresAt };
  }
  const rows = await postgresQuery<{ expires_at: Date }>(`insert into telegram_sessions(user_id,kind,state,expires_at,updated_at)
    values($1,$2,$3::jsonb,$4,now()) on conflict(user_id,kind) do update set state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    where telegram_sessions.expires_at<=now() returning expires_at`, [userId, kind, JSON.stringify(state), expiresAt]);
  if (rows[0]) return { claimed: true, expiresAt: new Date(rows[0].expires_at) };
  const current = await postgresQuery<{ expires_at: Date }>('select expires_at from telegram_sessions where user_id=$1 and kind=$2', [userId, kind]);
  return { claimed: false, expiresAt: new Date(current[0]!.expires_at) };
}

export async function deleteTelegramSession(userId: string, kind: string): Promise<void> {
  validKind(kind);
  if (!hasPostgresDatabase()) { localSessions.delete(key(userId, kind)); return; }
  await postgresQuery('delete from telegram_sessions where user_id=$1 and kind=$2', [userId, kind]);
}
