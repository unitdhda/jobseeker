import { hasPostgresDatabase, postgresQuery, withPostgresTransaction } from './postgres.ts';
import { claimCoordinationLease,releaseCoordinationLease } from './coordination-leases.ts';

const localReceipts = new Map<number, 'processing' | 'completed'>();
let lastCleanup = 0;

export async function claimTelegramUpdate(updateId: number, retryProcessing = false): Promise<boolean> {
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
      where update_id=$1 and (state='failed' or (state='processing' and (lease_expires_at<now() or $2))) returning update_id`,
    [updateId,retryProcessing]);
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

export function claimTelegramUserUpdateLease(userId: string, updateId: number): Promise<boolean> {
  return claimCoordinationLease(`telegram-user:${userId}`,String(updateId),5*60_000);
}

export function releaseTelegramUserUpdateLease(userId: string, updateId: number): Promise<void> {
  return releaseCoordinationLease(`telegram-user:${userId}`,String(updateId));
}
