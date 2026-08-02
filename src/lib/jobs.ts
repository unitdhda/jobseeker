import { config } from '../config.ts';
import { approvedUsers } from './database.ts';
import { startCycleStatus } from './telegram.ts';
import { ensureCvAndSearchProfiles, scorePendingVacancies } from './workflows.ts';
import { discoverPlatformVacancies } from '../platforms/registry.ts';
import { trace } from './trace.ts';
import { processCandidateQueue } from './candidate-queue.ts';
import { errorMessage } from './logging.ts';
import { mapConcurrent } from './adaptive-concurrency.ts';
import { llmUsageSince, llmUsageSnapshot, type LlmUsageReport } from './llm-usage.ts';

let cycleRunning = false;
export type UserTaskRunner = <T>(userId: string, task: () => Promise<T>) => Promise<T>;
const runDirectly: UserTaskRunner = (_userId, task) => task();

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
  llmUsage: LlmUsageReport;
}

function addPlatformResult(target: Record<string, PlatformScrapeResult>, platformId: string,
  result: Omit<PlatformScrapeResult, 'newVacancies'>): void {
  const current = target[platformId] ?? { searches: 0, seen: 0, discovered: 0, newVacancies: 0 };
  target[platformId] = { ...current, searches: current.searches + result.searches,
    seen: current.seen + result.seen, discovered: current.discovered + result.discovered };
}

export async function runScrapeCycle(runUserTask: UserTaskRunner = runDirectly): Promise<ScrapeCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  const usageBefore = llmUsageSnapshot();
  const cycleStatus = await startCycleStatus();
  cycleStatus?.set('scraping');
  try {
    const users = await approvedUsers(true);
    trace('cycle.start', { users: users.map((user) => user.userId), platforms: config.searchPlatforms,
      scoreLimitPerUser: config.userScoreLimitPerCycle });
    const platforms: Record<string, PlatformScrapeResult> = {};
    await mapConcurrent(users, config.userWorkflowConcurrency, async (user) => {
      try {
        await runUserTask(user.userId, async () => {
          const profiles = await ensureCvAndSearchProfiles(user.userId);
          for (const platformId of config.searchPlatforms) {
            try {
              trace('scrape.platform.start', { userId: user.userId, platform: platformId, profile: profiles[platformId] });
              const profile = profiles[platformId];
              if (!profile) throw new Error(`${platformId} search profile is unavailable`);
              addPlatformResult(platforms, platformId, await discoverPlatformVacancies(platformId,user.userId,profile));
            } catch (error) {
              console.error(`Failed to scrape ${platformId} for user ${user.userId}: ${errorMessage(error)}`);
            }
          }
        });
      } catch (error) {
        console.error(`Scrape allocation failed for user ${user.userId}: ${errorMessage(error)}`);
      }
    });
    const queue = await processCandidateQueue(users.map((user) => user.userId),
      (phase, current, total) => cycleStatus?.set(phase, current, total));
    for (const [source, count] of Object.entries(queue.bySource)) {
      if (platforms[source]) platforms[source].newVacancies = count;
    }
    const scoreCounts = await mapConcurrent(users, config.userWorkflowConcurrency, async (user) => {
      try {
        return await runUserTask(user.userId, () => scorePendingVacancies(user.userId, undefined,
          (phase, current, total) => cycleStatus?.set(phase, current, total), config.userScoreLimitPerCycle));
      } catch (error) {
        console.error(`Scoring allocation failed for user ${user.userId}: ${errorMessage(error)}`);
        return 0;
      }
    });
    const attempted = scoreCounts.reduce((sum, count) => sum + count, 0);
    const totals = Object.values(platforms).reduce((sum, platform) => ({
      searches: sum.searches + platform.searches, seen: sum.seen + platform.seen,
      discovered: sum.discovered + platform.discovered, newVacancies: sum.newVacancies + platform.newVacancies,
    }), { searches: 0, seen: 0, discovered: 0, newVacancies: 0 });
    const result = { platforms, users: users.length, ...totals, candidateQueue: queue, scoresAttempted: attempted,
      llmUsage: llmUsageSince(usageBefore) };
    trace('cycle.completed', result);
    console.info(`LLM cycle usage ${JSON.stringify(result.llmUsage)}`);
    console.info('Vacancy cycle complete', result);
    return result;
  } finally {
    await cycleStatus?.stop();
    cycleRunning = false;
  }
}
