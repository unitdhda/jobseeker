import { runSingletonScrapeCycle } from './vacancies/jobs.ts';
import { ensureCvAndSearchProfiles, tailorApplication } from './workflows.ts';
import { config } from './config.ts';
import { getCvHash, requireApprovedUser, usageInLast24Hours } from './database.ts';
import type { JobWorkerMessage, JobWorkerRequest, RefreshUserResult, SerializedApplication } from './worker-client.ts';
import { errorMessage } from './observability.ts';
import { KeyedTaskScheduler } from './concurrency.ts';

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
    }
  })();
});

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

send({ kind: 'ready' });
