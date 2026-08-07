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
  addSpend, approvedUsers, createMatches, dueUnits, getCvSource, getSearchProfile, getVacancy, nextUnitDueAt,
  recordUnitRun, spentToday, type Vacancy,
} from './postgres.ts';
import { deliverDueNotifications, normalizeListings } from './vacancies/jobs.ts';
import { closeSources, getSearchPlatform, type SearchPlan } from './vacancies/registry.ts';
import {
  careerProfilePlatformId, parseStoredCareerProfile, prefilterVacancy, type CareerProfile, type StoredCareerProfile,
} from '@jobseeker/engine';
import { scorePendingVacancies } from './workflows.ts';
import { llmUsageSince, llmUsageSnapshot } from './ai.ts';
import { errorMessage } from './observability.ts';
import { extensionShutdownHooks, extensionStartupHooks } from './vacancies/providers.ts';

const cadencePolicy = { floorMinutes: config.unitCadenceFloorMinutes, ceilingMinutes: config.unitCadenceCeilingMinutes };

function dayKey(now: Date): string { return now.toISOString().slice(0, 10); }

interface UserLens { userId: string; cvText: string; profile: CareerProfile }

/** Every approved user who can judge a vacancy: a CV and a current career profile make a lens; others wait. */
async function approvedLenses(): Promise<UserLens[]> {
  const users = await approvedUsers(true);
  const lenses: UserLens[] = [];
  for (const user of users) {
    const cv = await getCvSource(user.userId);
    if (!cv) continue;
    const profile = parseStoredCareerProfile(
      await getSearchProfile<StoredCareerProfile>(user.userId, careerProfilePlatformId), cv.cvSha256);
    if (profile) lenses.push({ userId: user.userId, cvText: cv.cvText, profile });
  }
  return lenses;
}

async function matchOne(lenses: UserLens[], vacancy: Vacancy, now: Date): Promise<{ matched: number; failures: number }> {
  return matchVacancy({
    approvedUserIds: async () => lenses.map((lens) => lens.userId),
    lexicalScore: async (userId) => {
      const lens = lenses.find((entry) => entry.userId === userId)!;
      const result = prefilterVacancy(
        lens.cvText, vacancy, config.prefilterMinScore, lens.profile, config.prefilterMaxAgeDays,
      );
      // The prefilter already folds the floor and recency into `filtered`; a filtered vacancy never matches.
      return result.filtered ? -1 : Math.max(0, Math.round(result.combinedScore));
    },
    matchFloor: 0,
    createMatches,
  }, { vacancyId: vacancy.id }, now);
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
  };
}

const judgmentIntervalMs = 2 * 60_000;

let loop: EngineLoop | undefined;
let loopDone: Promise<void> | undefined;

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
    for (const hook of extensionStartupHooks) {
      try { await hook(); } catch (error) { console.error(`Extension startup hook failed: ${errorMessage(error)}`); }
    }
    try { await loop!.run(); } finally {
      await closeSources().catch(() => undefined);
      for (const hook of extensionShutdownHooks) {
        try { await hook(); } catch (error) { console.error(`Extension shutdown hook failed: ${errorMessage(error)}`); }
      }
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
