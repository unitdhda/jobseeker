/**
 * Composes the engine loop from the app's parts: store repositories, source adapters, the lexical prefilter as the
 * per-user matching lens, the scoring workflow, and Telegram delivery. Runs inside the web process when RUN_JOBS is
 * on — the search_units.next_run_at column is the schedule, so there is no cron and no advisory lock; whoever runs
 * this loop owns discovery.
 */
import { config } from './config.ts';
import {
  createEngineLoop, drainScoring, matchVacancy, nextWakeMs, runSchedulerTick,
  type EngineLoop, type LoopPorts, type TickDiscovery,
} from '@jobseeker/engine';
import {
  addSpend, approvedUsers, createMatches, dueUnits, expireStaleMatches, getVacancy, nextUnitDueAt,
  tryAcquireSingletonLock, recordUnitRun, spentToday, type Vacancy,
} from './postgres.ts';
import { deliverDueNotifications, normalizeListings } from './vacancies/jobs.ts';
import { closeSources, getSearchPlatform, type SearchPlan } from './vacancies/registry.ts';
import { scorePendingVacancies } from './workflows.ts';
import { llmUsageSince, llmUsageSnapshot } from './ai.ts';
import { errorMessage } from './observability.ts';
import { extensionShutdownHooks, extensionStartupHooks } from './vacancies/providers.ts';
import { loadRoleEquivalenceResolver, tryRefreshRoleEquivalences } from './role-equivalence.ts';
import { loadIdfLookups, tryRefreshIdfVocabularies } from './idf.ts';
import { matchEvidence, userLens, type UserLens } from './matching.ts';

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

const retireIntervalMs = 3_600_000;
let lastRetiredAt = 0;

/**
 * Retires matches the budget never reached before their advert aged out. Hourly is ample for a 30-day limit,
 * and it keeps the judgment lane's two-minute wake cheap.
 */
async function retireStaleMatches(now: Date): Promise<number> {
  if (now.getTime() - lastRetiredAt < retireIntervalMs) return 0;
  lastRetiredAt = now.getTime();
  const retired = await expireStaleMatches(config.prefilterMaxAgeDays, now);
  if (retired) {
    console.info(`Retired ${retired} matches whose advert passed the ${config.prefilterMaxAgeDays}-day limit `
      + 'before the scoring budget reached them.');
  }
  return retired;
}

const maintenanceIntervalMs = 24 * 3_600_000;
let lastMaintainedAt = 0;

async function maintainMatchingVocabularies(now: Date): Promise<void> {
  if (now.getTime() - lastMaintainedAt < maintenanceIntervalMs) return;
  lastMaintainedAt = now.getTime();
  await tryRefreshRoleEquivalences();
  await tryRefreshIdfVocabularies();
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
    maintain: maintainMatchingVocabularies,
    retire: retireStaleMatches,
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
    await loadRoleEquivalenceResolver().catch((error) =>
      console.error(`Loading role equivalences failed; matching starts with the core vocabulary: ${errorMessage(error)}`));
    // Loaded, not rebuilt: process start stays cheap; daily maintenance rebuilds both vocabularies.
    await loadIdfLookups().catch((error) =>
      console.error(`Loading word rarity failed; the rarity evidence stays unmeasured: ${errorMessage(error)}`));
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
