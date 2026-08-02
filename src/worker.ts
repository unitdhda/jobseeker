import { runSingletonScrapeCycle } from './lib/singleton-cycle.ts';
import { ensureCvAndSearchProfiles, tailorApplication } from './lib/workflows.ts';
import { config } from './config.ts';
import { getCvHash, purgeSettledAgentSessions, requireApprovedUser, usageInLast24Hours } from './lib/database.ts';
import { startScriptRuntime } from './scripts/runtime.ts';
import type { JobWorkerMessage, JobWorkerRequest, RefreshUserResult, SerializedApplication } from './lib/job-worker-protocol.ts';
import { errorMessage } from './lib/logging.ts';
import { KeyedTaskScheduler } from './lib/adaptive-concurrency.ts';

const flue = await startScriptRuntime();
const userScheduler = new KeyedTaskScheduler(config.userWorkflowConcurrency);
let stopping = false;

function send(message: JobWorkerMessage): void {
  if (process.connected) process.send?.(message);
}

async function execute(request: JobWorkerRequest): Promise<unknown> {
  if (request.type === 'run-cycle') {
    return runSingletonScrapeCycle((userId, task) => userScheduler.run(userId, task));
  }
  return userScheduler.run(request.userId, async () => {
    if (request.type === 'refresh-user') {
      await requireApprovedUser(request.userId);
      if (await getCvHash(request.userId) !== request.cvHash) throw new Error('CV changed before profile refresh; using the newest queued version.');
      const used = await usageInLast24Hours(request.userId, 'search-profile');
      if (used + config.searchPlatforms.length > config.userDailySearchProfileLimit) {
        throw new Error(`Daily search-profile limit (${config.userDailySearchProfileLimit}) reached.`);
      }
      const profiles = await ensureCvAndSearchProfiles(request.userId, true, request.cvHash);
      const searchCount = Object.values(profiles).reduce<number>((total, profile) => {
        const searches = (profile as { searches?: unknown[] }).searches;
        return total + (Array.isArray(searches) ? searches.length : 0);
      }, 0);
      return { searchCount, platformCount: Object.keys(profiles).length, cycle: null } satisfies RefreshUserResult;
    }
    await requireApprovedUser(request.userId);
    const application = await tailorApplication(request.userId, request.vacancyId);
    return { tailoredCvPdfBase64: application.tailoredCvPdf.toString('base64'),
      coverLetter: application.coverLetter } satisfies SerializedApplication;
  });
}

process.on('message', (request: JobWorkerRequest) => {
  void (async () => {
    try { send({ kind: 'result', id: request.id, ok: true, result: await execute(request) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Background job ${request.type} failed: ${errorMessage(error)}`);
      send({ kind: 'result', id: request.id, ok: false, error: message });
    } finally {
      try { await purgeSettledAgentSessions(); }
      catch (error) { console.error(`Conversation cleanup failed: ${errorMessage(error)}`); }
    }
  })();
});

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.race([flue.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

send({ kind: 'ready' });
