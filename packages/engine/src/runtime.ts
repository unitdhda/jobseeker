/**
 * The engine's runtime orchestration, expressed over ports so the logic tests without a database or a scraper.
 * The app wires the ports to the store repositories and the source adapters; the loop entrypoint drives
 * runSchedulerTick and sleeps until the next unit is due.
 */
import { nextCadence, type CadencePolicy } from './cadence.ts';
import { mapConcurrent } from './concurrency.ts';
import { pickDueUnits } from './pick.ts';
import type { SearchPlan, SearchRecipient } from './contracts.ts';

export interface TickUnit {
  unitId: string;
  platform: string;
  query: unknown;
  cadenceMinutes: number;
  subscribers: SearchRecipient[];
}
export interface TickDiscovery {
  searches: number; users: number; seen: number; discovered: number;
  /** Per-search novelty, keyed by the search's own name; absent means only the aggregate is known. */
  discoveredBySearch?: Record<string, number>;
}
export interface TickPorts {
  cadencePolicy: CadencePolicy;
  /** How many of each user's units a tick may run per platform; the per-platform budget is subscribers times this. */
  queriesPerUserPerTick: number;
  /**
   * How many platforms may scrape at once. Cross-platform parallelism touches distinct hosts, so per-source
   * politeness is unchanged; providers that serialize internally (a shared browser) keep doing so. Default 1.
   */
  platformConcurrency?: number;
  dueUnits(now: Date): Promise<TickUnit[]>;
  discover(platform: string, plan: SearchPlan<unknown>): Promise<TickDiscovery>;
  recordUnitRun(unitId: string, cadenceMinutes: number, foundNovelty: boolean, now: Date): Promise<void>;
}
export interface TickReport {
  due: number;
  unitsRun: number;
  platformFailures: number;
  perPlatform: Record<string, { units: number; discovered: number }>;
}

export async function runSchedulerTick(ports: TickPorts, now: Date): Promise<TickReport> {
  const due = await ports.dueUnits(now);
  const byPlatform = new Map<string, TickUnit[]>();
  for (const unit of due) {
    const list = byPlatform.get(unit.platform) ?? [];
    list.push(unit);
    byPlatform.set(unit.platform, list);
  }
  const report: TickReport = { due: due.length, unitsRun: 0, platformFailures: 0, perPlatform: {} };
  const runPlatform = async ([platform, units]: [string, TickUnit[]]): Promise<void> => {
    const subscribers = new Set(units.flatMap((unit) => unit.subscribers.map((entry) => entry.userId)));
    const budget = Math.max(1, subscribers.size * ports.queriesPerUserPerTick);
    const picked = pickDueUnits(units.map((unit) => ({ unitId: unit.unitId, platform, nextRunAt: 0,
      subscribers: unit.subscribers.map((entry) => entry.userId) })), budget, now.getTime());
    const chosen = picked.map((entry) => units.find((unit) => unit.unitId === entry.unitId)!);
    const plan: SearchPlan<unknown> = { searches: chosen.map((unit) => ({ search: unit.query,
      recipients: unit.subscribers })) };
    let discovery: TickDiscovery;
    try {
      discovery = await ports.discover(platform, plan);
    } catch {
      // The units stay due and retry next tick; advancing them would silently skip a whole cadence period.
      report.platformFailures += 1;
      return;
    }
    for (const unit of chosen) {
      const name = (unit.query as { name?: string } | null)?.name;
      const bySearch = discovery.discoveredBySearch;
      const novelty = bySearch && name != null && name in bySearch
        ? bySearch[name]! > 0
        : discovery.discovered > 0;
      await ports.recordUnitRun(unit.unitId, nextCadence(unit.cadenceMinutes, novelty, ports.cadencePolicy),
        novelty, now);
      report.unitsRun += 1;
    }
    report.perPlatform[platform] = { units: chosen.length, discovered: discovery.discovered };
  };
  await mapConcurrent([...byPlatform], Math.max(1, ports.platformConcurrency ?? 1), runPlatform);
  return report;
}

const wakeFloorMs = 15_000;
const wakeCeilingMs = 5 * 60_000;

/** How long the loop may sleep: until the earliest unit is due, never under 15s, never over 5 minutes. */
export function nextWakeMs(units: readonly { nextRunAt: number }[], nowMs: number): number {
  if (!units.length) return wakeCeilingMs;
  const earliest = Math.min(...units.map((unit) => unit.nextRunAt));
  return Math.min(wakeCeilingMs, Math.max(wakeFloorMs, earliest - nowMs));
}

/**
 * One lens's verdict on one vacancy. The raw evidence features ride along so persistence can pair them with the
 * LLM's later judgement — that pairing is the calibration's training data, and recomputing features after the CV
 * has changed would silently corrupt it.
 */
export interface MatchEvidence {
  score: number; regexScore: number; lexicalCosine: number;
  /** The pair `regexScore` folds together, frozen separately so a later refit can weigh them apart. 0..1. */
  titleSimilarity?: number; skillCoverage?: number;
  /** Grade distance in [-1, 1], or null when neither title named a grade. Recorded, not yet weighed. */
  seniorityGap?: number | null;
}
export interface MatchCandidateInput extends MatchEvidence { userId: string; vacancyId: number }

export interface MatchPorts {
  approvedUserIds(): Promise<string[]>;
  /** The user's own lens over the vacancy; null means the prefilter rejected it outright. */
  lexicalScore(userId: string, vacancy: unknown): Promise<MatchEvidence | null>;
  matchFloor: number;
  createMatches(candidates: MatchCandidateInput[], now: Date): Promise<number>;
}
export interface MatchReport { evaluated: number; matched: number; failures: number }

/** Match-on-ingest: every approved user sees every new vacancy through their own vocabulary, floor filters. */
export async function matchVacancy(ports: MatchPorts, vacancy: { vacancyId: number },
  now: Date): Promise<MatchReport> {
  const users = await ports.approvedUserIds();
  const candidates: MatchCandidateInput[] = [];
  let failures = 0;
  for (const userId of users) {
    try {
      const evidence = await ports.lexicalScore(userId, vacancy);
      if (evidence && evidence.score >= ports.matchFloor) {
        candidates.push({ userId, vacancyId: vacancy.vacancyId, ...evidence });
      }
    } catch {
      failures += 1;
    }
  }
  const matched = candidates.length ? await ports.createMatches(candidates, now) : 0;
  return { evaluated: users.length, matched, failures };
}
