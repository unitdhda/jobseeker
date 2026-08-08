/**
 * Composes the engine loop from the app's parts: store repositories, source adapters, the lexical prefilter as the
 * per-user matching lens, the scoring workflow, and Telegram delivery. Runs inside the web process when RUN_JOBS is
 * on — the search_units.next_run_at column is the schedule, so there is no cron and no advisory lock; whoever runs
 * this loop owns discovery.
 */
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import {
  createEngineLoop, drainScoring, matchVacancy, nextWakeMs, runSchedulerTick,
  type EngineLoop, type LoopPorts, type TickDiscovery,
} from '@jobseeker/engine';
import {
  addSpend, approvedUsers, calibrationExamples, calibrationLabelsSince, createMatches,
  dueUnits, getVacancy, latestCalibrationAttemptAt, nextUnitDueAt,
  tryAcquireSingletonLock,
  recordUnitRun, saveCalibration, spentToday, type Vacancy,
} from './postgres.ts';
import { deliverDueNotifications, normalizeListings } from './vacancies/jobs.ts';
import { closeSources, getSearchPlatform, type SearchPlan } from './vacancies/registry.ts';
import {
  calibratedMatchProbability, compareOnHoldout, fitPrefilterCalibration, vacancyRecency,
  type TrainingExample,
} from '@jobseeker/engine';
import { scorePendingVacancies } from './workflows.ts';
import { llmUsageSince, llmUsageSnapshot } from './ai.ts';
import { errorMessage } from './observability.ts';
import { extensionShutdownHooks, extensionStartupHooks } from './vacancies/providers.ts';
import { loadRoleEquivalenceResolver, tryRefreshRoleEquivalences } from './role-equivalence.ts';
import {
  activeCalibration, activeCalibrationFittedAt, loadActiveCalibration, matchEvidence,
  reportCalibrationHealth, setActiveCalibration,
  userLens, type UserLens,
} from './matching.ts';

const cadencePolicy = { floorMinutes: config.unitCadenceFloorMinutes, ceilingMinutes: config.unitCadenceCeilingMinutes };

function dayKey(now: Date): string { return now.toISOString().slice(0, 10); }

/** Every approved user who can judge a vacancy: a CV and a current career profile make a lens; others wait. */
async function approvedLenses(): Promise<UserLens[]> {
  const lenses: UserLens[] = [];
  for (const user of await approvedUsers(true)) {
    const lens = await userLens(user.userId);
    if (lens) lenses.push(lens);
  }
  return lenses;
}

async function matchOne(lenses: UserLens[], vacancy: Vacancy, now: Date): Promise<{ matched: number; failures: number }> {
  return matchVacancy({
    approvedUserIds: async () => lenses.map((lens) => lens.userId),
    lexicalScore: async (userId) =>
      matchEvidence(lenses.find((entry) => entry.userId === userId)!, vacancy, now),
    matchFloor: 0,
    createMatches: (candidates, at) => createMatches(candidates.map(({ score, ...candidate }) =>
      ({ ...candidate, lexicalScore: score })), at),
  }, { vacancyId: vacancy.id }, now);
}

const calibrationRefitIntervalMs = 24 * 3_600_000;
const calibrationMinNewLabels = 50;

/** A stable, non-reversible key for a user's fitting-only intercept. Never used to look anyone up. */
function calibrationUserKey(userId: string): string {
  return createHash('sha256').update(`calibration-user:${userId}`).digest('hex').slice(0, 12);
}

/**
 * The daily self-calibration: refit on the frozen evidence+label pairs, and adopt the result only if it orders
 * the newest rows no worse than whatever orders claims today (the active model, or the stored lexical scores
 * before any model exists). Candidate and incumbent are scored on the same held-out tail and compared with a
 * paired bootstrap, so a difference inside resampling noise is not mistaken for an improvement. Every attempt
 * is recorded, so a rejected fit both leaves an audit row and arms the 24-hour gate.
 */
async function refitCalibration(now: Date): Promise<void> {
  if (!config.calibrationAutoRefit) return;
  const lastAttempt = await latestCalibrationAttemptAt();
  // The vocabulary rides the same daily cadence: mining is cheap and its input is the same profile set.
  if (!lastAttempt || now.getTime() - Date.parse(lastAttempt) >= calibrationRefitIntervalMs) {
    await tryRefreshRoleEquivalences();
  }
  if (lastAttempt && now.getTime() - Date.parse(lastAttempt) < calibrationRefitIntervalMs) return;
  if (await calibrationLabelsSince(activeCalibrationFittedAt()) < calibrationMinNewLabels) return;
  const rows = await calibrationExamples();
  if (rows.length < config.calibrationMinLabels) return;
  const examples: TrainingExample[] = rows.map((row) => ({
    regexScore: row.regexScore, lexicalCosine: row.lexicalCosine, source: row.source,
    // Null until this match's row was written with the richer evidence; zero is "contributes nothing", which is
    // the honest reading for a row whose features were never recorded.
    titleSimilarity: row.titleSimilarity ?? 0, skillCoverage: row.skillCoverage ?? 0,
    ageBand: vacancyRecency({ publishedAt: row.publishedAt }, Date.parse(row.scoreUpdatedAt), 3_650).band,
    scoredAt: Date.parse(row.scoreUpdatedAt),
    // Fitting-only: both absorb strictness that is not the match's fault. Undefined on rows predating the column.
    judge: row.scoreModel ?? undefined,
    // Pseudonymous on purpose. The intercept only has to separate one person's rows from another's, and the
    // fitted document is printed to logs and copied into PREFILTER_CALIBRATION_JSON — a place a Telegram user
    // id must never end up.
    user: calibrationUserKey(row.userId),
    label: row.llmScore >= config.calibrationLabelScore,
  }));
  const fit = await fitPrefilterCalibration(examples);
  const active = activeCalibration();
  const labels = fit.holdoutIndices.map((index) => examples[index]!.label);
  // The incumbent is judged on the candidate's holdout, not on the whole corpus: comparing a model on rows it
  // was fitted on against one that never saw them is how the old gate flattered every refit.
  const incumbentScores = fit.holdoutIndices.map((index) => (active
    ? calibratedMatchProbability(active, examples[index]!)
    : rows[index]!.storedLexicalScore));
  const verdict = compareOnHoldout(fit.holdoutScores, incumbentScores, labels);
  const accepted = fit.judgeable && verdict.accepted;
  const reason = fit.judgeable ? verdict.reason
    : `holdout too small or single-class (${fit.holdoutIndices.length} rows), so no refit can be justified`;
  await saveCalibration(fit.calibration, { candidate: verdict.candidate, incumbent: verdict.incumbent,
    deltaAuc: verdict.deltaAuc, deltaAucLower: verdict.deltaAucLower, holdout: verdict.holdoutExamples,
    examples: fit.examples, positives: fit.positives, judgeable: fit.judgeable, reason,
    label: `llm_score>=${config.calibrationLabelScore}` }, accepted);
  console.info(`Calibration refit ${accepted ? 'accepted' : 'rejected'} on ${fit.examples} examples `
    + `(${fit.holdoutIndices.length} held out): ${reason}.`);
  if (accepted) setActiveCalibration(fit.calibration, now.toISOString());
  // A rejected refit is normal; a run of them means the ordering is ageing with nothing to replace it.
  reportCalibrationHealth(now);
}

function loopPorts(): LoopPorts {
  return {
    tick: (now) => runSchedulerTick({
      cadencePolicy,
      queriesPerUserPerTick: config.searchQueriesPerCycle,
      platformConcurrency: config.tickPlatformConcurrency,
      dueUnits,
      discover: async (platform, plan): Promise<TickDiscovery> =>
        getSearchPlatform(platform).discover(plan as SearchPlan<never>),
      recordUnitRun,
    }, now),
    normalize: async (now) => {
      const users = await approvedUsers(true);
      const result = await normalizeListings(config.normalizationBatchSizePerUser * Math.max(1, users.length));
      if (result.selected) console.info('Normalization pass', { ...result, at: now.toISOString() });
      return result;
    },
    matchVacancies: async (vacancyIds, now) => {
      const lenses = await approvedLenses();
      let matched = 0; let failures = 0;
      for (const vacancyId of vacancyIds) {
        const vacancy = await getVacancy(vacancyId);
        if (!vacancy) continue;
        const report = await matchOne(lenses, vacancy, now);
        matched += report.matched; failures += report.failures;
      }
      return { matched, failures };
    },
    scoreDue: (now) => drainScoring({
      scoringUserIds: async () => (await approvedUsers(true)).map((user) => user.userId),
      spentTodayUsd: (userId) => spentToday(userId, dayKey(now)),
      drainUser: async (userId, claimLimit) => {
        const before = llmUsageSnapshot();
        const result = await scorePendingVacancies(userId, undefined, undefined, claimLimit);
        const cost = llmUsageSince(before).cost.total;
        if (cost > 0) await addSpend(userId, dayKey(now), cost, 'scores');
        return result;
      },
    }, { dailyBudgetUsd: config.userDailyLlmBudgetUsd, claimLimit: config.userScoreLimitPerCycle }, now),
    deliver: async (now) => {
      const { sendDailyDigest, sendPendingAlerts } = await import('./telegram/delivery.ts');
      await deliverDueNotifications(sendPendingAlerts,
        (userId) => sendDailyDigest(userId, { scheduled: true }), now);
    },
    calibrate: refitCalibration,
  };
}

const judgmentIntervalMs = 2 * 60_000;

let loop: EngineLoop | undefined;
let loopDone: Promise<void> | undefined;

let releaseEngineLock: (() => Promise<void>) | undefined;
const engineLockKey = 'jobseeker-engine-loop';

export function startEngineLoop(): void {
  if (loop) return;
  // Plain sleeps suffice: createEngineLoop races every sleep against stop, so shutdown stays prompt.
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  loop = createEngineLoop(loopPorts(), {
    discovery: {
      nextWakeMs: async () => {
        const due = await nextUnitDueAt();
        return nextWakeMs(due ? [{ nextRunAt: due.getTime() }] : [], Date.now());
      },
      sleep,
    },
    judgment: { nextWakeMs: async () => judgmentIntervalMs, sleep },
  });
  loopDone = (async () => {
    // The schedule has no other guard: a second RUN_JOBS process would duplicate discovery and delivery, so the
    // loop runs only while this session holds the advisory lock.
    const release = await tryAcquireSingletonLock(engineLockKey).catch((error) => {
      console.error(`Engine-loop lock acquisition failed: ${errorMessage(error)}`);
      return null;
    });
    if (!release) {
      console.error('Another process holds the engine-loop lock; RUN_JOBS stays idle here.');
      loop = undefined;
      return;
    }
    releaseEngineLock = release;
    // A previously accepted refit outranks the env bootstrap; failure to load keeps the bootstrap, not silence.
    await loadActiveCalibration().catch((error) =>
      console.error(`Loading the active calibration failed: ${errorMessage(error)}`));
    // Whatever that left us with, say plainly what is ordering the scoring queue before the loop starts using it.
    reportCalibrationHealth();
    await loadRoleEquivalenceResolver().catch((error) =>
      console.error(`Loading role equivalences failed; matching starts with the core vocabulary: ${errorMessage(error)}`));
    for (const hook of extensionStartupHooks) {
      try { await hook(); } catch (error) { console.error(`Extension startup hook failed: ${errorMessage(error)}`); }
    }
    try { await loop!.run(); } finally {
      await closeSources().catch(() => undefined);
      for (const hook of extensionShutdownHooks) {
        try { await hook(); } catch (error) { console.error(`Extension shutdown hook failed: ${errorMessage(error)}`); }
      }
      await releaseEngineLock?.().catch(() => undefined);
      releaseEngineLock = undefined;
    }
  })();
  console.info('Engine loop started; search_units.next_run_at owns the schedule.');
}

export async function stopEngineLoop(): Promise<void> {
  if (!loop) return;
  loop.stop();
  await loopDone;
  loop = undefined; loopDone = undefined;
}
