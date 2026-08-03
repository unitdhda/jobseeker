import { deliverDueNotifications,runSingletonScrapeCycle } from './vacancies/jobs.ts';
import { persistHhBrowserState, restoreHhBrowserState } from './runtime-state.ts';
import { enqueueDueDeliveryTasks } from './cloud-tasks.ts';
import { config } from './config.ts';
import { closeHhBrowser } from './vacancies/hh.ts';

await restoreHhBrowserState();
try {
  const result=await runSingletonScrapeCycle();
  if(result){
    if(config.backgroundDeliveryAsync){
      const queued=await enqueueDueDeliveryTasks();
      console.info(`Queued ${queued} delivery tasks.`);
    }else{
      const {sendDailyDigest,sendPendingAlerts}=await import('./telegram.ts');
      await deliverDueNotifications(sendPendingAlerts,userId=>sendDailyDigest(userId,{scheduled:true}));
    }
  }
} finally {
  await closeHhBrowser();
  await persistHhBrowserState().catch((error) =>
    console.error(`Could not persist HH browser state: ${error instanceof Error ? error.message : String(error)}`));
}
process.exit(0);
