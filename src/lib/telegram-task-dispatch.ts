import { enqueueBackgroundTask } from './background-tasks.ts';
import { dispatchCloudTask } from './cloud-task-dispatch.ts';
import { telegramUpdateTaskKind } from './telegram-background-task.ts';
import { telegramUpdateUserId } from './telegram-webhook-receipts.ts';

export async function enqueueTelegramUpdateTask(update: unknown,updateId: number): Promise<boolean> {
  const userId=telegramUpdateUserId(update);
  const taskKey=`telegram-update:${updateId}`;
  const queued=await enqueueBackgroundTask({ taskKey,kind:telegramUpdateTaskKind,payload:{ update },
    serializationKey:userId?`user:${userId}`:null,maxAttempts:10 });
  await dispatchCloudTask(taskKey);
  return queued.created;
}
