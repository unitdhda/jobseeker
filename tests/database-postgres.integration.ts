import assert from 'node:assert/strict';
import { closePostgresPool, postgresQuery } from '../src/lib/postgres.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the Postgres integration test.');
const d = await import('../src/lib/database.ts');
const sessions = await import('../src/lib/telegram-sessions.ts');
const webhook = await import('../src/lib/telegram-webhook-receipts.ts');
const tasks = await import('../src/lib/background-tasks.ts');
const taskWorkers = await import('../src/lib/background-task-worker.ts');
const suffix = `${Date.now()}-${process.pid}`;
const userId = `integration-${suffix}`;
const sourceId = `integration-${suffix}`;
const chatId = `integration-chat-${suffix}`;
const leaseUpdateId = 7_000_000_000_000_000 + process.pid * 2;
let vacancyId: number | undefined;
try {
  const legacyTables = await postgresQuery<{ table_name: string }>(`select table_name from information_schema.tables
    where table_schema='public' and table_name=any($1::text[]) order by table_name`,
    [['app_migrations','applications','global_scheduler_settings','pending_deliveries','scores','telegram_user_update_leases']]);
  assert.deepEqual(legacyTables, []);
  const consolidatedColumns = await postgresQuery<{ column_name: string; data_type: string }>(`select column_name,data_type
    from information_schema.columns where table_schema='public' and table_name='user_vacancies'`);
  assert.equal(consolidatedColumns.find((column) => column.column_name === 'score')?.data_type, 'integer');
  assert.equal(consolidatedColumns.find((column) => column.column_name === 'application_updated_at')?.data_type,
    'timestamp with time zone');

  const touched = await d.touchTelegramUser({ userId, chatId, displayName: 'Integration Test' });
  assert.equal(touched.status, 'unregistered');
  assert.equal((await d.requestAccess({ userId, chatId, displayName: 'Integration Test' })).user.status, 'pending');
  assert.equal((await d.setUserStatus(userId, 'approved'))?.status, 'approved');
  await sessions.setTelegramSession(userId, 'window-setup', { step: 'start' }, 60_000);
  assert.deepEqual(await sessions.getTelegramSession(userId, 'window-setup'), { step: 'start' });
  assert.equal((await sessions.claimTelegramSession(userId, 'cv-cooldown', {}, 60_000)).claimed, true);
  assert.equal((await sessions.claimTelegramSession(userId, 'cv-cooldown', {}, 60_000)).claimed, false);
  assert.equal(await webhook.claimTelegramUserUpdateLease(userId, leaseUpdateId), true);
  assert.equal(await webhook.claimTelegramUserUpdateLease(userId, leaseUpdateId + 1), false);
  await webhook.releaseTelegramUserUpdateLease(userId, leaseUpdateId);
  assert.equal(await webhook.claimTelegramUserUpdateLease(userId, leaseUpdateId + 1), true);
  await webhook.releaseTelegramUserUpdateLease(userId, leaseUpdateId + 1);

  const retryKind=`integration-retry-${suffix}`; const retryKey=`integration:a-retry:${suffix}`;
  const enqueued=await tasks.enqueueBackgroundTask({ taskKey:retryKey,kind:retryKind,userId,payload:{ value:1 },maxAttempts:3 });
  assert.equal(enqueued.created,true);
  assert.equal((await tasks.enqueueBackgroundTask({ taskKey:retryKey,kind:retryKind,userId,payload:{ value:1 },maxAttempts:3 })).created,false);
  await assert.rejects(tasks.enqueueBackgroundTask({ taskKey:retryKey,kind:retryKind,userId,payload:{ value:2 } }),/different task/);
  const firstClaim=await tasks.claimBackgroundTask({ workerId:`integration-a-${suffix}`,kinds:[retryKind],leaseMs:60_000 });
  assert.equal(firstClaim?.attempts,1); assert.ok(firstClaim?.leaseOwner);
  assert.deepEqual(await tasks.saveBackgroundTaskCheckpoint(retryKey,firstClaim!.leaseOwner!,{ prepared:true }),{ prepared:true });
  assert.ok(await tasks.renewBackgroundTaskLease(retryKey,firstClaim!.leaseOwner!,60_000));
  assert.equal(await tasks.failBackgroundTask(retryKey,firstClaim!.leaseOwner!,new Error('temporary'),{ retryAfterMs:0 }),'queued');
  const retryClaim=await tasks.claimBackgroundTask({ workerId:`integration-b-${suffix}`,kinds:[retryKind],leaseMs:60_000 });
  assert.equal(retryClaim?.attempts,2); assert.deepEqual(retryClaim?.checkpoint,{ prepared:true });
  await tasks.completeBackgroundTask(retryKey,retryClaim!.leaseOwner!,{ delivered:true });
  const completedTask=await tasks.getBackgroundTask(retryKey);
  assert.equal(completedTask?.state,'completed'); assert.deepEqual(completedTask?.payload,{});
  assert.deepEqual(completedTask?.checkpoint,{ prepared:true,delivered:true });

  const serialKind=`integration-serial-${suffix}`; const serialKeyA=`integration:b-serial-a:${suffix}`;
  const serialKeyB=`integration:c-serial-b:${suffix}`;
  await tasks.enqueueBackgroundTask({ taskKey:serialKeyA,kind:serialKind,userId,payload:{} });
  await tasks.enqueueBackgroundTask({ taskKey:serialKeyB,kind:serialKind,userId,payload:{} });
  const serialA=await tasks.claimBackgroundTask({ workerId:`integration-a-${suffix}`,kinds:[serialKind],leaseMs:60_000 });
  assert.ok(serialA); assert.equal(await tasks.claimBackgroundTask({ workerId:`integration-b-${suffix}`,kinds:[serialKind],leaseMs:60_000 }),null);
  await tasks.completeBackgroundTask(serialA!.taskKey,serialA!.leaseOwner!);
  const serialB=await tasks.claimBackgroundTask({ workerId:`integration-b-${suffix}`,kinds:[serialKind],leaseMs:60_000 });
  assert.ok(serialB); await tasks.completeBackgroundTask(serialB!.taskKey,serialB!.leaseOwner!);

  const failureKind=`integration-failure-${suffix}`; const failureKey=`integration:d-failure:${suffix}`;
  await tasks.enqueueBackgroundTask({ taskKey:failureKey,kind:failureKind,userId,payload:{ private:'discard-me' },maxAttempts:1 });
  const failure=await tasks.claimBackgroundTask({ workerId:`integration-f-${suffix}`,kinds:[failureKind],leaseMs:60_000 });
  assert.equal(await tasks.failBackgroundTask(failureKey,failure!.leaseOwner!,new Error('See person@example.com at https://example.com')),'failed');
  const failedTask=await tasks.getBackgroundTask(failureKey);
  assert.equal(failedTask?.state,'failed'); assert.deepEqual(failedTask?.payload,{});
  assert.doesNotMatch(failedTask?.lastError??'',/person@example\.com|https:\/\//);

  const expiryKind=`integration-expiry-${suffix}`; const expiryKey=`integration:e-expiry:${suffix}`;
  await tasks.enqueueBackgroundTask({ taskKey:expiryKey,kind:expiryKind,userId,payload:{ private:'discard-me' },maxAttempts:1 });
  const expiring=await tasks.claimBackgroundTask({ workerId:`integration-e-${suffix}`,kinds:[expiryKind],leaseMs:60_000 });
  assert.ok(expiring);
  await postgresQuery("update background_tasks set lease_expires_at=now()-interval '1 second' where task_key=$1",[expiryKey]);
  await postgresQuery("update coordination_leases set lease_expires_at=now()-interval '1 second' where lease_owner=$1",[expiring!.leaseOwner]);
  assert.equal(await tasks.claimBackgroundTask({ workerId:`integration-e2-${suffix}`,kinds:[expiryKind],leaseMs:60_000 }),null);
  assert.equal((await tasks.getBackgroundTask(expiryKey))?.state,'failed');

  const workerKind=`integration-worker-${suffix}`; const workerKey=`integration:f-worker:${suffix}`;
  await tasks.enqueueBackgroundTask({ taskKey:workerKey,kind:workerKind,userId,payload:{ value:42 } });
  const taskWorker=new taskWorkers.BackgroundTaskWorker({ workerId:`integration-worker-${suffix}`,
    handlers:{ [workerKind]:async(task,context)=> {
      assert.equal(task.payload.value,42); await context.checkpoint({ handled:true }); return { delivered:true };
    } } });
  assert.equal(await taskWorker.runTask(workerKey),'completed');
  assert.deepEqual((await tasks.getBackgroundTask(workerKey))?.checkpoint,{ handled:true,delivered:true });

  await d.saveCvSource(userId, 'cv.txt', `cv-${suffix}`, {
    text: 'Integration CV with TypeScript PostgreSQL distributed systems experience. '.repeat(5),
    document: { version: 1, blocks: [{ type: 'paragraph', text: 'Integration CV' }] },
    sourceFormat: 'txt', mediaType: 'text/plain', parserName: 'integration', parserVersion: '1',
  });
  assert.equal(await d.getCvHash(userId), `cv-${suffix}`);
  await d.saveSearchProfile(userId, 'hh', { searches: [{ text: 'distributed systems' }] });
  assert.deepEqual(await d.getSearchProfile(userId, 'hh'), { searches: [{ text: 'distributed systems' }] });
  await d.saveDeliverySettings(userId, { startMinutes: 540, endMinutes: 1320, digestMinutes: 570, timezone: '+03:00' });
  assert.equal((await d.getDeliverySettings(userId))?.digestMinutes, 570);

  const saved = await d.upsertVacancy({ source: 'hh', sourceId, name: 'Postgres Integration Engineer', employer: 'Integration Employer',
    area: 'Remote', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null, experience: 'senior',
    employment: 'full', schedule: 'full', workFormat: 'remote', description: 'Build distributed TypeScript services backed by PostgreSQL.',
    keySkills: ['TypeScript', 'PostgreSQL'], url: `https://hh.ru/vacancy/${Date.now()}`, publishedAt: '',
    sourceQuery: 'integration', contentHash: `content-${suffix}` });
  vacancyId = saved.id;
  assert.equal(saved.duplicate, false);
  await d.savePrefilterScore(userId, vacancyId, `context-${suffix}`, `content-${suffix}`, { regexScore: 90,
    embeddingCosine: 0.8, embeddingScore: 90, semanticCosine: null, semanticScore: null, semanticStatus: 'disabled',
    combinedScore: 90, filtered: false, auditSelected: false, reasons: ['integration'] });
  assert.equal((await d.prefilterQueueStats(userId, `context-${suffix}`)).queued, 1);
  assert.equal((await d.rankedPendingVacancies(userId, `context-${suffix}`, 5))[0]?.id, vacancyId);
  await d.saveScore(userId, vacancyId, 91, 'Backend', 'Strong integration match', ['TypeScript'], ['None'], false);
  assert.equal((await d.getScoredVacancy(userId, vacancyId))?.score, 91);
  assert.equal((await d.searchScoredVacancies(userId, 'Postgres Integration'))[0]?.id, vacancyId);
  assert.equal((await d.unsentHighScoreVacancies(userId, 80))[0]?.primaryTrack, 'Backend');
  await d.markAlerted(userId, vacancyId);

  assert.equal(await d.recordVacancyCandidate(userId, { source: 'habr', sourceId, url: `https://career.habr.com/vacancies/${sourceId}`,
    searchName: 'integration', title: 'Integration Candidate', publishedAt: '' }), true);
  const candidate = (await d.candidatesNeedingPrefilter(userId, 'different-context', 10)).find((item) => item.sourceId === sourceId);
  assert.ok(candidate);
  await d.saveCandidatePrefilter(userId, candidate, 'different-context', { regexScore: 88, embeddingCosine: 0.7, embeddingScore: 85,
    semanticCosine: null, semanticScore: null, semanticStatus: 'disabled', combinedScore: 87, filtered: false,
    auditSelected: false, reasons: ['integration'] });
  assert.equal((await d.rankedCandidateQueueForUsers([userId], 5))[0]?.sourceId, sourceId);
  await d.recordUsage(userId, 'score');
  assert.equal(await d.usageInLast24Hours(userId, 'score'), 1);
  assert.equal((await d.userUsageSummaries()).some((summary) => summary.userId === userId && summary.scores24h === 1), true);
  assert.equal((await d.exportUserData(userId)).cvSource != null, true);
  await d.deleteUserData(userId);
  assert.equal(await d.getCvHash(userId), null);
  console.info('Postgres business repository integration passed.');
} finally {
  await postgresQuery('delete from coordination_leases where resource_key=$1', [`telegram-user:${userId}`]).catch(() => undefined);
  await postgresQuery('delete from telegram_users where user_id=$1', [userId]).catch(() => undefined);
  await postgresQuery('delete from vacancy_candidates where source_id=$1', [sourceId]).catch(() => undefined);
  if (vacancyId != null) await postgresQuery('delete from vacancies where id=$1', [vacancyId]).catch(() => undefined);
  await closePostgresPool();
}
