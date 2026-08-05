/**
 * The engine's main loop: tick the scheduler, normalize what it discovered, match new vacancies to users,
 * drain scoring under the daily budgets, deliver. Each stage is failure-isolated — a broken normalizer must not
 * stop scoring, and a broken tick must not stop delivery — so one iteration always runs every stage it can.
 * Like engine-runtime, everything is expressed over ports; the app wires them to repositories and workflows.
 */
import type { TickReport } from './engine-runtime.ts';

export interface NormalizeReport { vacancyIds: number[]; failed: number; closed: number }
export interface ScoreDueReport { users: number; drained: number; skippedOverBudget: number; failures: number }

export interface LoopPorts {
  tick(now: Date): Promise<TickReport>;
  /** Normalizes queued listings; returns the ids of vacancies that became visible this round. */
  normalize(now: Date): Promise<NormalizeReport>;
  matchVacancies(vacancyIds: number[], now: Date): Promise<{ matched: number; failures: number }>;
  scoreDue(now: Date): Promise<ScoreDueReport>;
  deliver(now: Date): Promise<void>;
}

export interface IterationReport {
  tick?: TickReport;
  normalize?: NormalizeReport;
  matched: number;
  scoring?: ScoreDueReport;
  stageFailures: string[];
}

async function stage<T>(report: IterationReport, name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    report.stageFailures.push(name);
    console.error(`Engine loop stage ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function runLoopIteration(ports: LoopPorts, now: Date): Promise<IterationReport> {
  const report: IterationReport = { matched: 0, stageFailures: [] };
  report.tick = await stage(report, 'tick', () => ports.tick(now)) ?? undefined;
  report.normalize = await stage(report, 'normalize', () => ports.normalize(now)) ?? undefined;
  if (report.normalize?.vacancyIds.length) {
    const matched = await stage(report, 'match', () => ports.matchVacancies(report.normalize!.vacancyIds, now));
    report.matched = matched?.matched ?? 0;
  }
  report.scoring = await stage(report, 'score', () => ports.scoreDue(now)) ?? undefined;
  await stage(report, 'deliver', () => ports.deliver(now));
  return report;
}

export interface ScoringPorts {
  scoringUserIds(): Promise<string[]>;
  spentTodayUsd(userId: string, now: Date): Promise<number>;
  drainUser(userId: string, claimLimit: number, now: Date): Promise<{ attempted: number; completed: number }>;
}
export interface ScoringPolicy { dailyBudgetUsd: number; claimLimit: number }

/** Per-user scoring under the daily spend ceiling; users never pay for each other's failures. */
export async function drainScoring(ports: ScoringPorts, policy: ScoringPolicy, now: Date): Promise<ScoreDueReport> {
  const users = await ports.scoringUserIds();
  const report: ScoreDueReport = { users: users.length, drained: 0, skippedOverBudget: 0, failures: 0 };
  for (const userId of users) {
    try {
      if (await ports.spentTodayUsd(userId, now) >= policy.dailyBudgetUsd) {
        report.skippedOverBudget += 1;
        continue;
      }
      await ports.drainUser(userId, policy.claimLimit, now);
      report.drained += 1;
    } catch (error) {
      report.failures += 1;
      console.error(`Scoring drain failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

export interface LoopClock {
  /** How long to pause after an iteration — wired to nextWakeMs over the earliest due unit. */
  nextWakeMs(now: Date): Promise<number>;
  sleep(ms: number): Promise<void>;
}
export interface EngineLoop { run(): Promise<void>; stop(): void }

const fallbackWakeMs = 60_000;

export function createEngineLoop(ports: LoopPorts, clock: LoopClock): EngineLoop {
  let running = true;
  return {
    stop() { running = false; },
    async run() {
      while (running) {
        try {
          const report = await runLoopIteration(ports, new Date());
          if (report.stageFailures.length) console.warn(`Engine iteration degraded: ${report.stageFailures.join(', ')}`);
        } catch (error) {
          console.error(`Engine iteration failed outright: ${error instanceof Error ? error.message : String(error)}`);
        }
        const wake = await clock.nextWakeMs(new Date()).catch(() => fallbackWakeMs);
        await clock.sleep(wake);
      }
    },
  };
}
