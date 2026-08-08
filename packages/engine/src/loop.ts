/**
 * The engine's main loop as two independent lanes sharing one store. Discovery (tick → normalize → match) is slow
 * and IO-bound — a polite hh normalization pass legitimately takes many minutes. Judgment (score → deliver) is
 * fast and budget-bound. Coupling them meant every alert waited for the slowest scrape; each lane now runs on its
 * own clock, and the store's guarantees (skip-locked claims, append-only ingest, state-guarded transitions) make
 * that safe. Stages stay failure-isolated within a lane, and like engine-runtime everything is expressed over
 * ports.
 */
import type { TickReport } from './runtime.ts';

export interface NormalizeReport {
  vacancyIds: number[]; failed: number; closed: number;
  expired: number; selected: number; refreshed: number; normalized: number; bySource: Record<string, number>;
}
export interface ScoreDueReport { users: number; drained: number; skippedOverBudget: number; failures: number }

export interface DiscoveryPorts {
  tick(now: Date): Promise<TickReport>;
  /** Normalizes queued listings; returns the ids of vacancies that became visible this round. */
  normalize(now: Date): Promise<NormalizeReport>;
  matchVacancies(vacancyIds: number[], now: Date): Promise<{ matched: number; failures: number }>;
}
export interface JudgmentPorts {
  scoreDue(now: Date): Promise<ScoreDueReport>;
  deliver(now: Date): Promise<void>;
  /** Optional periodic self-calibration; the port owns its own cadence gating and must be cheap when not due. */
  calibrate?(now: Date): Promise<void>;
  /**
   * Optional retirement of matches whose advert aged out before anyone judged them. The queue is drained in
   * score order against a bounded budget, so its tail is never reached; without this those matches stay
   * "waiting" forever and the count of what was passed over cannot be told from what is still pending. Owns its
   * own cadence gating, like `calibrate`.
   */
  retire?(now: Date): Promise<number>;
}
export interface LoopPorts extends DiscoveryPorts, JudgmentPorts {}

export interface DiscoveryReport {
  tick?: TickReport;
  normalize?: NormalizeReport;
  matched: number;
  stageFailures: string[];
}
export interface JudgmentReport { scoring?: ScoreDueReport; retired?: number; stageFailures: string[] }

async function stage<T>(failures: string[], name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    failures.push(name);
    console.error(`Engine ${name} stage failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function runDiscoveryIteration(ports: DiscoveryPorts, now: Date): Promise<DiscoveryReport> {
  const report: DiscoveryReport = { matched: 0, stageFailures: [] };
  report.tick = await stage(report.stageFailures, 'tick', () => ports.tick(now)) ?? undefined;
  report.normalize = await stage(report.stageFailures, 'normalize', () => ports.normalize(now)) ?? undefined;
  if (report.normalize?.vacancyIds.length) {
    const matched = await stage(report.stageFailures, 'match',
      () => ports.matchVacancies(report.normalize!.vacancyIds, now));
    report.matched = matched?.matched ?? 0;
  }
  return report;
}

export async function runJudgmentIteration(ports: JudgmentPorts, now: Date): Promise<JudgmentReport> {
  const report: JudgmentReport = { stageFailures: [] };
  report.scoring = await stage(report.stageFailures, 'score', () => ports.scoreDue(now)) ?? undefined;
  await stage(report.stageFailures, 'deliver', () => ports.deliver(now));
  if (ports.retire) report.retired = await stage(report.stageFailures, 'retire', () => ports.retire!(now)) ?? undefined;
  if (ports.calibrate) await stage(report.stageFailures, 'calibrate', () => ports.calibrate!(now));
  return report;
}

export interface ScoringPorts {
  scoringUserIds(): Promise<string[]>;
  spentTodayUsd(userId: string, now: Date): Promise<number>;
  drainUser(userId: string, claimLimit: number, now: Date): Promise<{ attempted: number; completed: number }>;
}
export interface ScoringPolicy {
  dailyBudgetUsd: number;
  claimLimit: number;
  /** The share of the day's budget available from the first minute, so early UTC hours are never starved. */
  paceFloorFraction?: number;
}

/**
 * Per-user scoring under a paced ceiling: the daily budget accrues with the UTC day (a leaky bucket), so what one
 * noisy morning cannot spend stays available for the evening's discoveries, and best-first claiming hands each
 * hour's slice to the best matches available then. Users never pay for each other's failures.
 */
export async function drainScoring(ports: ScoringPorts, policy: ScoringPolicy, now: Date): Promise<ScoreDueReport> {
  const dayFraction = (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000;
  const ceiling = policy.dailyBudgetUsd * Math.max(policy.paceFloorFraction ?? 1 / 12, dayFraction);
  const users = await ports.scoringUserIds();
  const report: ScoreDueReport = { users: users.length, drained: 0, skippedOverBudget: 0, failures: 0 };
  for (const userId of users) {
    try {
      if (await ports.spentTodayUsd(userId, now) >= ceiling) {
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

export interface LaneClock {
  nextWakeMs(now: Date): Promise<number>;
  sleep(ms: number): Promise<void>;
}
export interface EngineLoop { run(): Promise<void>; stop(): void }

export interface LaneStatus {
  iterations: number; lastIterationAt: string | null; lastStageFailures: string[]; lastWakeMs: number | null;
}
export interface EngineLoopStatus {
  running: boolean;
  discovery: LaneStatus & { lastDue: number; lastUnitsRun: number };
  judgment: LaneStatus;
}
const emptyLane = (): LaneStatus => ({ iterations: 0, lastIterationAt: null, lastStageFailures: [], lastWakeMs: null });
let status: EngineLoopStatus = { running: false, discovery: { ...emptyLane(), lastDue: 0, lastUnitsRun: 0 }, judgment: emptyLane() };

/** What /status reports about the scheduler: observability only, never control flow. */
export function engineLoopStatus(): EngineLoopStatus {
  return { running: status.running,
    discovery: { ...status.discovery, lastStageFailures: [...status.discovery.lastStageFailures] },
    judgment: { ...status.judgment, lastStageFailures: [...status.judgment.lastStageFailures] } };
}

const fallbackWakeMs = 60_000;

export function createEngineLoop(ports: LoopPorts, clocks: { discovery: LaneClock; judgment: LaneClock }): EngineLoop {
  let running = true;
  let signalStop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { signalStop = resolve; });

  function patchLane(name: 'discovery' | 'judgment', patch: Partial<LaneStatus>): void {
    if (name === 'discovery') status.discovery = { ...status.discovery, ...patch };
    else status.judgment = { ...status.judgment, ...patch };
  }

  async function lane(name: 'discovery' | 'judgment', clock: LaneClock,
    iterate: (now: Date) => Promise<{ stageFailures: string[] }>): Promise<void> {
    while (running) {
      try {
        const report = await iterate(new Date());
        if (report.stageFailures.length) console.warn(`Engine ${name} degraded: ${report.stageFailures.join(', ')}`);
        patchLane(name, { iterations: status[name].iterations + 1,
          lastIterationAt: new Date().toISOString(), lastStageFailures: report.stageFailures });
      } catch (error) {
        console.error(`Engine ${name} iteration failed outright: ${error instanceof Error ? error.message : String(error)}`);
      }
      const wake = await clock.nextWakeMs(new Date()).catch(() => fallbackWakeMs);
      patchLane(name, { lastWakeMs: wake });
      // Racing the clock against stop keeps shutdown prompt whatever sleep the clock implements.
      if (running) await Promise.race([clock.sleep(wake), stopped]);
    }
  }

  return {
    stop() { running = false; status = { ...status, running: false }; signalStop(); },
    async run() {
      status = { ...status, running: true };
      await Promise.all([
        lane('discovery', clocks.discovery, async (now) => {
          const report = await runDiscoveryIteration(ports, now);
          status.discovery = { ...status.discovery, lastDue: report.tick?.due ?? 0,
            lastUnitsRun: report.tick?.unitsRun ?? 0 };
          return report;
        }),
        lane('judgment', clocks.judgment, (now) => runJudgmentIteration(ports, now)),
      ]);
      status = { ...status, running: false };
    },
  };
}
