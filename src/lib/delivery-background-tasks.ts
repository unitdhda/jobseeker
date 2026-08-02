import { approvedUsers,markDigestRun } from './database.ts';
import { enqueueBackgroundTask } from './background-tasks.ts';
import { dispatchCloudTask } from './cloud-task-dispatch.ts';
import { PermanentTaskError,type BackgroundTaskHandler } from './background-task-worker.ts';
import { isDigestDue,isWithinDeliveryWindow } from './schedules.ts';
import { sendDailyDigest,sendPendingAlerts } from './telegram.ts';
import { mapConcurrent } from './adaptive-concurrency.ts';
import { config } from '../config.ts';

export const alertDeliveryTaskKind='deliver-alerts';
export const digestDeliveryTaskKind='deliver-digest';
const dispatchBucketMs=30*60_000;

function taskUserId(task:{ userId:string|null; payload:Record<string,unknown> }): string {
  const payloadUser=task.payload.userId;
  if (!task.userId||payloadUser!==task.userId) throw new PermanentTaskError('Delivery task user does not match its payload.');
  return task.userId;
}

export const handleAlertDeliveryTask:BackgroundTaskHandler=async(task,context)=> {
  const userId=taskUserId(task);
  if (!await isWithinDeliveryWindow(userId)) return { skippedOutsideWindow:true };
  const delivered=await sendPendingAlerts(userId);
  await context.checkpoint({ delivered });
  return { delivered };
};

export const handleDigestDeliveryTask:BackgroundTaskHandler=async(task,context)=> {
  const userId=taskUserId(task); const now=new Date();
  if (!await isDigestDue(userId,now)) return { skippedNotDue:true };
  const delivered=await sendDailyDigest(userId);
  await markDigestRun(userId,now.toISOString());
  await context.checkpoint({ delivered,digestCompleted:true });
  return { delivered,digestCompleted:true };
};

export async function enqueueDueDeliveryTasks(now=new Date()): Promise<number> {
  const bucket=Math.floor(now.getTime()/dispatchBucketMs); const dispatches:Array<()=>Promise<void>>=[];
  for (const user of await approvedUsers()) {
    if (await isWithinDeliveryWindow(user.userId,now)) dispatches.push(async()=> {
      const taskKey=`delivery:alerts:${user.userId}:${bucket}`;
      await enqueueBackgroundTask({ taskKey,kind:alertDeliveryTaskKind,userId:user.userId,payload:{ userId:user.userId } });
      await dispatchCloudTask(taskKey);
    });
    if (await isDigestDue(user.userId,now)) dispatches.push(async()=> {
      const taskKey=`delivery:digest:${user.userId}:${bucket}`;
      await enqueueBackgroundTask({ taskKey,kind:digestDeliveryTaskKind,userId:user.userId,payload:{ userId:user.userId },maxAttempts:10 });
      await dispatchCloudTask(taskKey);
    });
  }
  await mapConcurrent(dispatches,config.deliveryConcurrency,(dispatch)=>dispatch());
  return dispatches.length;
}
