import { config } from '../config.ts';
import { approvedUsers, usageInLast24Hours } from './database.ts';
import { scrapeHh } from './hh.ts';
import { scrapeHireHi } from './hirehi.ts';
import {
  scrapeAvito, scrapeGeekJob, scrapeGetmatch, scrapeHabr, scrapeRabota, scrapeSuperJob,
} from './additional-sources.ts';
import { startCycleStatus } from './telegram.ts';
import { ensureCvAndSearchProfiles, scorePendingVacancies } from './workflows.ts';
import type { HhSearchProfile } from '../platforms/hh.ts';
import type { HireHiSearchProfile } from '../platforms/hirehi.ts';
import type { AvitoSearchProfile, GetmatchSearchProfile, TextSearchProfile } from '../platforms/additional.ts';
import { trace } from './trace.ts';
import { processCandidateQueue } from './candidate-queue.ts';
import { nextFairScoreRound } from './fairness.ts';
import { errorMessage } from './logging.ts';
import { mapConcurrent } from './adaptive-concurrency.ts';

let cycleRunning = false;

export interface PlatformScrapeResult { searches: number; seen: number; discovered: number; newVacancies: number }
export interface ScrapeCycleResult {
  platforms: Record<string, PlatformScrapeResult>;
  users: number;
  searches: number;
  seen: number;
  discovered: number;
  newVacancies: number;
  candidateQueue: Awaited<ReturnType<typeof processCandidateQueue>>;
  scoresAttempted: number;
}

function addPlatformResult(target: Record<string, PlatformScrapeResult>, platformId: string,
  result: Omit<PlatformScrapeResult, 'newVacancies'>): void {
  const current = target[platformId] ?? { searches: 0, seen: 0, discovered: 0, newVacancies: 0 };
  target[platformId] = { ...current, searches: current.searches + result.searches,
    seen: current.seen + result.seen, discovered: current.discovered + result.discovered };
}

export async function runScrapeCycle(): Promise<ScrapeCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  const cycleStatus = await startCycleStatus();
  cycleStatus?.set('scraping');
  try {
    const users = approvedUsers(true);
    trace('cycle.start', { users: users.map((user) => user.userId), platforms: config.searchPlatforms,
      scoreBatchSize: config.scoreBatchSize });
    const platforms: Record<string, PlatformScrapeResult> = {};
    for (const user of users) {
      const profiles = await ensureCvAndSearchProfiles(user.userId);
      for (const platformId of config.searchPlatforms) {
        try {
          trace('scrape.platform.start', { userId: user.userId, platform: platformId, profile: profiles[platformId] });
          if (platformId === 'hh') {
            const profile = profiles.hh as HhSearchProfile | undefined;
            if (!profile) throw new Error('HH search profile is unavailable');
            addPlatformResult(platforms, platformId, { searches: profile.searches.length, ...await scrapeHh(user.userId, profile) });
          } else if (platformId === 'hirehi') {
            const profile = profiles.hirehi as HireHiSearchProfile | undefined;
            if (!profile) throw new Error('HireHi search profile is unavailable');
            addPlatformResult(platforms, platformId, { searches: profile.searches.length, ...await scrapeHireHi(user.userId, profile) });
          } else if (platformId === 'getmatch') {
            const profile = profiles.getmatch as GetmatchSearchProfile | undefined;
            if (!profile) throw new Error('getmatch search profile is unavailable');
            addPlatformResult(platforms, platformId, { searches: profile.searches.length, ...await scrapeGetmatch(user.userId, profile) });
          } else if (platformId === 'avito') {
            const profile = profiles.avito as AvitoSearchProfile | undefined;
            if (!profile) throw new Error('Avito search profile is unavailable');
            addPlatformResult(platforms, platformId, { searches: profile.searches.length, ...await scrapeAvito(user.userId, profile) });
          } else {
            const profile = profiles[platformId] as TextSearchProfile | undefined;
            if (!profile) throw new Error(`${platformId} search profile is unavailable`);
            const scraper = platformId === 'habr' ? scrapeHabr : platformId === 'geekjob' ? scrapeGeekJob
              : platformId === 'superjob' ? scrapeSuperJob : platformId === 'rabota' ? scrapeRabota : undefined;
            if (!scraper) throw new Error(`No scraper is registered for ${platformId}`);
            addPlatformResult(platforms, platformId, { searches: profile.searches.length, ...await scraper(user.userId, profile) });
          }
        } catch (error) {
          console.error(`Failed to scrape ${platformId} for user ${user.userId}: ${errorMessage(error)}`);
        }
      }
    }
    const queue = await processCandidateQueue(users.map((user) => user.userId),
      (phase, current, total) => cycleStatus?.set(phase, current, total));
    for (const [source, count] of Object.entries(queue.bySource)) {
      if (platforms[source]) platforms[source].newVacancies = count;
    }
    let attempted = 0;
    const usage = new Map(users.map((user) => [user.userId, usageInLast24Hours(user.userId, 'score')]));
    const cycleUsage = new Map(users.map((user) => [user.userId, 0]));
    while (attempted < config.scoreBatchSize) {
      let progressed = false;
      const round = nextFairScoreRound(users.map((user) => ({
        userId: user.userId,
        used: usage.get(user.userId) ?? 0,
        cycleUsed: cycleUsage.get(user.userId) ?? 0,
        unlimited: user.userId === config.telegramUserId,
      })), config.scoreBatchSize - attempted, config.userDailyScoreLimit, config.userScoreLimitPerCycle);
      if (!round.length) break;
      const counts = await mapConcurrent(round, config.scoreAgentConcurrencyMax, async (allocation) => {
        try {
          return await scorePendingVacancies(allocation.userId, undefined,
            (phase, current, total) => cycleStatus?.set(phase, current, total), allocation.limit);
        } catch (error) {
          console.error(`Scoring allocation failed for user ${allocation.userId}: ${errorMessage(error)}`);
          return 0;
        }
      });
      for (const [index, allocation] of round.entries()) {
        const count = counts[index];
        attempted += count;
        usage.set(allocation.userId, (usage.get(allocation.userId) ?? 0) + count);
        cycleUsage.set(allocation.userId, (cycleUsage.get(allocation.userId) ?? 0) + count);
        if (count) progressed = true;
      }
      if (!progressed) break;
    }
    const totals = Object.values(platforms).reduce((sum, platform) => ({
      searches: sum.searches + platform.searches, seen: sum.seen + platform.seen,
      discovered: sum.discovered + platform.discovered, newVacancies: sum.newVacancies + platform.newVacancies,
    }), { searches: 0, seen: 0, discovered: 0, newVacancies: 0 });
    const result = { platforms, users: users.length, ...totals, candidateQueue: queue, scoresAttempted: attempted };
    trace('cycle.completed', result);
    console.info('Vacancy cycle complete', result);
    return result;
  } finally {
    await cycleStatus?.stop();
    cycleRunning = false;
  }
}
