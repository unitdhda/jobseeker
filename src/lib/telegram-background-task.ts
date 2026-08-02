import { PermanentTaskError,type BackgroundTaskHandler } from './background-task-worker.ts';
import { completeTelegramUpdate, claimTelegramUpdate, failTelegramUpdate } from './telegram-webhook-receipts.ts';
import { handleTelegramWebhookUpdate } from './telegram.ts';

export const telegramUpdateTaskKind='telegram-update';

function updateIdFrom(update: unknown): number {
  const updateId=Number((update as { update_id?: unknown }|null)?.update_id);
  if (!Number.isSafeInteger(updateId)||updateId<0) throw new PermanentTaskError('Queued Telegram update_id is invalid.');
  return updateId;
}

export const handleTelegramUpdateTask: BackgroundTaskHandler=async(task,context)=> {
  if (task.checkpoint.telegramCompleted===true) return;
  const update=task.payload.update; const updateId=updateIdFrom(update);
  if (task.taskKey!==`telegram-update:${updateId}`) throw new PermanentTaskError('Telegram task key does not match its update_id.');
  if (!await claimTelegramUpdate(updateId,true)) return { telegramCompleted:true };
  try {
    await handleTelegramWebhookUpdate(update);
    await completeTelegramUpdate(updateId);
    await context.checkpoint({ telegramCompleted:true });
    return { telegramCompleted:true };
  } catch (error) {
    await failTelegramUpdate(updateId,error).catch(()=>undefined);
    throw error;
  }
};
