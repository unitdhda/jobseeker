import type { TickReport } from './runtime.ts';
import type { UserId } from './contracts.ts';

export interface NormalizeReport {
  readonly vacancyIds: readonly number[];
  readonly failed: number;
  readonly closed: number;
  readonly expired: number;
  readonly selected: number;
  readonly refreshed: number;
  readonly normalized: number;
  readonly bySource: Readonly<Record<string, number>>;
}

export interface ScoreDueReport {
  readonly users: number;
  readonly drained: number;
  readonly skippedOverBudget: number;
  readonly failures: number;
}

export interface DiscoveryPorts {
  tick(now: Date): Promise<TickReport>;
  normalize(now: Date): Promise<NormalizeReport>;
  matchVacancies(vacancyIds: readonly number[], now: Date): Promise<{ readonly matched: number; readonly failures: number }>;
}

export interface JudgmentPorts {
  scoreDue(now: Date): Promise<ScoreDueReport>;
  deliver(now: Date): Promise<void>;
  retire?(now: Date): Promise<number>;
  maintain?(now: Date): Promise<void>;
}

export interface LoopPorts extends DiscoveryPorts, JudgmentPorts {
  observeDiscovery?(report: DiscoveryReport): void;
}

export interface DiscoveryReport {
  readonly tick?: TickReport;
  readonly normalize?: NormalizeReport;
  readonly matched: number;
  readonly stageFailures: readonly string[];
}

export interface JudgmentReport {
  readonly scoring?: ScoreDueReport;
  readonly retired?: number;
  readonly stageFailures: readonly string[];
}

/** Engine stages report stable names only; application adapters own sanitized error logging and tracing. */
async function runStage<TResult>(
  failures: string[],
  name: string,
  run: () => Promise<TResult>,
): Promise<TResult | undefined> {
  try {
    return await run();
  } catch {
    failures.push(name);
    return undefined;
  }
}

function validVacancyIds(ids: readonly number[]): readonly number[] {
  const unique = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('Invalid normalization report: vacancy IDs must be positive safe integers.');
    }
    if (unique.has(id)) throw new TypeError('Invalid normalization report: duplicate vacancy ID encountered.');
    unique.add(id);
  }
  return Object.freeze([...ids]);
}

export async function runDiscoveryIteration(ports: DiscoveryPorts, now: Date): Promise<DiscoveryReport> {
  const failures: string[] = [];
  const tick = await runStage(failures, 'tick', () => ports.tick(now));
  const normalize = await runStage(failures, 'normalize', () => ports.normalize(now));
  let matched = 0;

  if (normalize?.vacancyIds.length) {
    const result = await runStage(failures, 'match', async () =>
      ports.matchVacancies(validVacancyIds(normalize.vacancyIds), now));
    matched = result?.matched ?? 0;
  }

  return Object.freeze({
    ...(tick === undefined ? {} : { tick }),
    ...(normalize === undefined ? {} : { normalize }),
    matched,
    stageFailures: Object.freeze(failures),
  });
}

export async function runJudgmentIteration(ports: JudgmentPorts, now: Date): Promise<JudgmentReport> {
  const failures: string[] = [];
  const scoring = await runStage(failures, 'score', () => ports.scoreDue(now));
  await runStage(failures, 'deliver', () => ports.deliver(now));
  const retired = ports.retire
    ? await runStage(failures, 'retire', () => ports.retire!(now))
    : undefined;
  if (ports.maintain) await runStage(failures, 'maintain', () => ports.maintain!(now));

  return Object.freeze({
    ...(scoring === undefined ? {} : { scoring }),
    ...(retired === undefined ? {} : { retired }),
    stageFailures: Object.freeze(failures),
  });
}

export interface ScoringPorts {
  scoringUserIds(): Promise<readonly UserId[]>;
  spentTodayUsd(userId: UserId, now: Date): Promise<number>;
  drainUser(
    userId: UserId,
    claimLimit: number,
    now: Date,
  ): Promise<{ readonly attempted: number; readonly completed: number }>;
}

export interface ScoringPolicy {
  readonly dailyBudgetUsd: number;
  readonly claimLimit: number;
  /** Share of the daily budget available at midnight; defaults to 1/12. */
  readonly paceFloorFraction?: number;
}

function assertScoringPolicy(policy: ScoringPolicy): number {
  if (!Number.isFinite(policy.dailyBudgetUsd) || policy.dailyBudgetUsd < 0) {
    throw new RangeError(
      `Invalid daily scoring budget: expected a finite nonnegative USD amount, received ${policy.dailyBudgetUsd}.`,
    );
  }
  if (!Number.isSafeInteger(policy.claimLimit) || policy.claimLimit < 1) {
    throw new RangeError(`Invalid scoring claim limit: expected a positive safe integer, received ${policy.claimLimit}.`);
  }
  const floor = policy.paceFloorFraction ?? 1 / 12;
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new RangeError(`Invalid scoring pace floor: expected a finite number from 0 through 1, received ${floor}.`);
  }
  return floor;
}

function validDate(date: Date, name: string): number {
  if (!(date instanceof Date)) throw new TypeError(`Invalid engine loop input: ${name} must be a Date.`);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid engine loop input: ${name} must be a valid Date.`);
  return timestamp;
}

/** Drains each user's queue against that user's own UTC-day-paced budget; no global budget can cause starvation. */
export async function drainScoring(
  ports: ScoringPorts,
  policy: ScoringPolicy,
  now: Date,
): Promise<ScoreDueReport> {
  const floor = assertScoringPolicy(policy);
  const nowMs = validDate(now, 'now');
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayFraction = Math.min(1, Math.max(0, (nowMs - dayStart) / 86_400_000));
  const ceiling = policy.dailyBudgetUsd * Math.max(floor, dayFraction);
  const users = await ports.scoringUserIds();
  if (new Set(users).size !== users.length) {
    throw new TypeError('Invalid scoring input: duplicate user ID encountered.');
  }

  let drained = 0;
  let skippedOverBudget = 0;
  let failures = 0;
  for (const userId of users) {
    if (ceiling === 0) {
      skippedOverBudget += 1;
      continue;
    }
    try {
      const spent = await ports.spentTodayUsd(userId, now);
      if (!Number.isFinite(spent) || spent < 0) {
        throw new RangeError('Invalid scoring usage: spent-today amount must be finite and nonnegative.');
      }
      if (spent >= ceiling) {
        skippedOverBudget += 1;
        continue;
      }
      await ports.drainUser(userId, policy.claimLimit, now);
      drained += 1;
    } catch {
      failures += 1;
    }
  }

  return Object.freeze({ users: users.length, drained, skippedOverBudget, failures });
}

export interface LaneClock {
  nextWakeMs(now: Date): Promise<number>;
  sleep(ms: number): Promise<void>;
}

export interface LaneStatus {
  readonly iterations: number;
  readonly lastIterationAt: string | null;
  readonly lastStageFailures: readonly string[];
  readonly lastWakeMs: number | null;
}

export interface EngineLoopStatus {
  readonly running: boolean;
  readonly discovery: LaneStatus & { readonly lastDue: number; readonly lastUnitsRun: number;
    readonly lastSuccessfulPlatforms: readonly string[]; readonly lastFailedPlatforms: readonly string[] };
  readonly judgment: LaneStatus;
}

export interface EngineLoop {
  run(): Promise<void>;
  stop(): void;
  status(): EngineLoopStatus;
}

const fallbackWakeMs = 60_000;

function emptyLane(): LaneStatus {
  return { iterations: 0, lastIterationAt: null, lastStageFailures: Object.freeze([]), lastWakeMs: null };
}

function nativeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validWakeMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid lane wake delay: expected a finite nonnegative number, received ${value}.`);
  }
  return value;
}

/** Runs discovery and judgment on independent clocks; stop races every sleep so shutdown never waits a full cadence. */
export function createEngineLoop(
  ports: LoopPorts,
  clocks: { readonly discovery: LaneClock; readonly judgment: LaneClock },
): EngineLoop {
  let running = false;
  let stopped = false;
  let runPromise: Promise<void> | null = null;
  let releaseStop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { releaseStop = resolve; });
  let discoveryStatus = { ...emptyLane(), lastDue: 0, lastUnitsRun: 0,
    lastSuccessfulPlatforms: Object.freeze([]) as readonly string[], lastFailedPlatforms: Object.freeze([]) as readonly string[] };
  let judgmentStatus = emptyLane();

  const sleepOrStop = async (clock: LaneClock, milliseconds: number): Promise<boolean> => {
    try {
      await Promise.race([clock.sleep(milliseconds), stopSignal]);
      return false;
    } catch {
      // A broken injected sleep must not create a hot retry loop or kill the other lane.
      await Promise.race([nativeSleep(fallbackWakeMs), stopSignal]);
      return true;
    }
  };

  const discoveryLane = async (): Promise<void> => {
    while (!stopped) {
      const now = new Date();
      const report = await runDiscoveryIteration(ports, now);
      try { ports.observeDiscovery?.(report); } catch { /* Observability must not stop engine work. */ }
      const failures = [...report.stageFailures];
      let wakeMs = fallbackWakeMs;
      try {
        wakeMs = validWakeMs(await clocks.discovery.nextWakeMs(new Date()));
      } catch {
        failures.push('clock');
      }
      discoveryStatus = {
        iterations: discoveryStatus.iterations + 1,
        lastIterationAt: now.toISOString(),
        lastStageFailures: Object.freeze([...failures]),
        lastWakeMs: wakeMs,
        lastDue: report.tick?.due ?? 0,
        lastUnitsRun: report.tick?.unitsRun ?? 0,
        lastSuccessfulPlatforms: Object.freeze([...(report.tick?.successfulPlatforms ?? [])]),
        lastFailedPlatforms: Object.freeze([...(report.tick?.failedPlatforms ?? [])]),
      };
      const sleepFailed = !stopped && await sleepOrStop(clocks.discovery, wakeMs);
      if (sleepFailed) {
        failures.push('sleep');
        discoveryStatus = { ...discoveryStatus, lastStageFailures: Object.freeze([...failures]) };
      }
    }
  };

  const judgmentLane = async (): Promise<void> => {
    while (!stopped) {
      const now = new Date();
      const report = await runJudgmentIteration(ports, now);
      const failures = [...report.stageFailures];
      let wakeMs = fallbackWakeMs;
      try {
        wakeMs = validWakeMs(await clocks.judgment.nextWakeMs(new Date()));
      } catch {
        failures.push('clock');
      }
      judgmentStatus = {
        iterations: judgmentStatus.iterations + 1,
        lastIterationAt: now.toISOString(),
        lastStageFailures: Object.freeze([...failures]),
        lastWakeMs: wakeMs,
      };
      const sleepFailed = !stopped && await sleepOrStop(clocks.judgment, wakeMs);
      if (sleepFailed) {
        failures.push('sleep');
        judgmentStatus = { ...judgmentStatus, lastStageFailures: Object.freeze([...failures]) };
      }
    }
  };

  return Object.freeze({
    run(): Promise<void> {
      if (runPromise) return runPromise;
      running = true;
      runPromise = Promise.all([discoveryLane(), judgmentLane()])
        .then(() => undefined)
        .finally(() => { running = false; });
      return runPromise;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      releaseStop();
    },

    status(): EngineLoopStatus {
      return Object.freeze({
        running,
        discovery: Object.freeze({
          ...discoveryStatus,
          lastStageFailures: Object.freeze([...discoveryStatus.lastStageFailures]),
          lastSuccessfulPlatforms: Object.freeze([...discoveryStatus.lastSuccessfulPlatforms]),
          lastFailedPlatforms: Object.freeze([...discoveryStatus.lastFailedPlatforms]),
        }),
        judgment: Object.freeze({
          ...judgmentStatus,
          lastStageFailures: Object.freeze([...judgmentStatus.lastStageFailures]),
        }),
      });
    },
  });
}
