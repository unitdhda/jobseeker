import { hasPostgresDatabase, postgresQuery, withPostgresTransaction } from './postgres.ts';

const localReceipts = new Map<number, 'processing' | 'completed'>();
const localUserLeases = new Map<string, { updateId: number; expiresAt: number }>();
let lastCleanup = 0;

export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('Telegram update_id is invalid.');
  if (!hasPostgresDatabase()) {
    if (localReceipts.has(updateId)) return false;
    localReceipts.set(updateId, 'processing');
    if (localReceipts.size > 10_000) localReceipts.delete(localReceipts.keys().next().value!);
    return true;
  }
  const claimed = await withPostgresTransaction(async (client) => {
    const inserted = await client.query(`insert into telegram_update_receipts
      (update_id,state,attempts,lease_expires_at) values ($1,'processing',1,now()+interval '5 minutes')
      on conflict (update_id) do nothing returning update_id`, [updateId]);
    if (inserted.rowCount) return true;
    const retried = await client.query(`update telegram_update_receipts set state='processing',attempts=attempts+1,
      lease_expires_at=now()+interval '5 minutes',last_error=null
      where update_id=$1 and (state='failed' or (state='processing' and lease_expires_at<now())) returning update_id`, [updateId]);
    return Boolean(retried.rowCount);
  });
  if (Date.now() - lastCleanup > 3_600_000) {
    lastCleanup = Date.now();
    void postgresQuery("delete from telegram_update_receipts where received_at<now()-interval '7 days'")
      .catch(() => undefined);
  }
  return claimed;
}

export async function completeTelegramUpdate(updateId: number): Promise<void> {
  if (!hasPostgresDatabase()) { localReceipts.set(updateId, 'completed'); return; }
  await postgresQuery(`update telegram_update_receipts set state='completed',completed_at=now(),lease_expires_at=null,last_error=null
    where update_id=$1`, [updateId]);
}

export async function failTelegramUpdate(updateId: number, error: unknown): Promise<void> {
  if (!hasPostgresDatabase()) { localReceipts.delete(updateId); return; }
  const failureType = error instanceof Error ? error.name : 'UnknownError';
  await postgresQuery(`update telegram_update_receipts set state='failed',lease_expires_at=null,last_error=$2
    where update_id=$1`, [updateId, failureType.slice(0, 120)]);
}

export function telegramUpdateUserId(update: unknown): string | null {
  if (!update || typeof update !== 'object') return null;
  const value = update as { message?: { from?: { id?: unknown } }; callback_query?: { from?: { id?: unknown } } };
  const id = value.message?.from?.id ?? value.callback_query?.from?.id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}

export async function claimTelegramUserUpdateLease(userId: string, updateId: number): Promise<boolean> {
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  if (!hasPostgresDatabase()) {
    const current = localUserLeases.get(userId);
    if (current && current.expiresAt > Date.now() && current.updateId !== updateId) return false;
    localUserLeases.set(userId, { updateId, expiresAt: expiresAt.getTime() });
    return true;
  }
  const rows = await postgresQuery(`insert into telegram_user_update_leases(user_id,update_id,lease_expires_at,updated_at)
    values($1,$2,$3,now()) on conflict(user_id) do update set update_id=excluded.update_id,
    lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
    where telegram_user_update_leases.lease_expires_at<=now() or telegram_user_update_leases.update_id=excluded.update_id
    returning user_id`, [userId, updateId, expiresAt]);
  return Boolean(rows.length);
}

export async function releaseTelegramUserUpdateLease(userId: string, updateId: number): Promise<void> {
  if (!hasPostgresDatabase()) {
    if (localUserLeases.get(userId)?.updateId === updateId) localUserLeases.delete(userId);
    return;
  }
  await postgresQuery('delete from telegram_user_update_leases where user_id=$1 and update_id=$2', [userId, updateId]);
}
