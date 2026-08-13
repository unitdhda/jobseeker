import { nextCadence, type CadencePolicy } from './cadence.ts';
import { mapConcurrent } from './concurrency.ts';
import type { SearchPlan, SearchRecipient, SourceKey, UserId } from './contracts.ts';
import type { SearchUnitId } from './identity.ts';
import { pickDueUnits } from './pick.ts';

export interface TickUnit {
  readonly unitId: SearchUnitId;
  readonly platform: SourceKey;
  readonly query: unknown;
  readonly cadenceMinutes: number;
  readonly subscribers: readonly SearchRecipient[];
  readonly nextRunAt: Date;
}

export interface TickDiscovery {
  readonly searches: number;
  readonly users: number;
  readonly seen: number;
  readonly discovered: number;
  /** Per-search novelty keyed by the representative search name; absence means only aggregate novelty is known. */
  readonly discoveredBySearch?: Readonly<Record<string, number>>;
}

export interface TickPorts {
  readonly cadencePolicy: CadencePolicy;
  readonly queriesPerUserPerTick: number;
  readonly platformConcurrency?: number;
  dueUnits(now: Date): Promise<readonly TickUnit[]>;
  discover(platform: SourceKey, plan: SearchPlan<unknown>): Promise<TickDiscovery>;
  recordUnitRun(
    unitId: SearchUnitId,
    cadenceMinutes: number,
    foundNovelty: boolean,
    now: Date,
  ): Promise<void>;
}

export interface PlatformTickReport {
  readonly units: number;
  readonly discovered: number;
}

export interface TickReport {
  readonly due: number;
  readonly unitsRun: number;
  readonly platformFailures: number;
  readonly unitUpdateFailures: number;
  readonly perPlatform: Readonly<Record<string, PlatformTickReport>>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDate(date: Date, name: string): number {
  if (!(date instanceof Date)) throw new TypeError(`Invalid runtime input: ${name} must be a Date.`);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid runtime input: ${name} must be a valid Date.`);
  return timestamp;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid ${name}: expected a positive safe integer, received ${value}.`);
  }
}

function representativeSearchName(query: unknown): string | null {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(query, 'name');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
}

function assertTickUnits(units: readonly TickUnit[]): void {
  const unitIds = new Set<SearchUnitId>();
  for (const unit of units) {
    if (unitIds.has(unit.unitId)) throw new TypeError('Invalid scheduler input: duplicate unit ID encountered.');
    unitIds.add(unit.unitId);
    validDate(unit.nextRunAt, 'unit nextRunAt');

    const users = new Set<UserId>();
    for (const recipient of unit.subscribers) {
      if (users.has(recipient.userId)) {
        throw new TypeError('Invalid scheduler input: a unit contains duplicate recipient user IDs.');
      }
      users.add(recipient.userId);
    }
  }
}

/**
 * Runs one scheduler tick. Provider failures are isolated by platform and leave selected units due; successful
 * platforms update each unit independently so one persistence failure cannot suppress sibling cadence updates.
 */
export async function runSchedulerTick(ports: TickPorts, now: Date): Promise<TickReport> {
  validDate(now, 'now');
  assertPositiveSafeInteger(ports.queriesPerUserPerTick, 'queries-per-user tick budget');
  const platformConcurrency = ports.platformConcurrency ?? 1;
  assertPositiveSafeInteger(platformConcurrency, 'platform concurrency');

  const due = await ports.dueUnits(now);
  assertTickUnits(due);
  const byPlatform = new Map<SourceKey, TickUnit[]>();
  for (const unit of due) {
    const platformUnits = byPlatform.get(unit.platform) ?? [];
    platformUnits.push(unit);
    byPlatform.set(unit.platform, platformUnits);
  }

  let unitsRun = 0;
  let platformFailures = 0;
  let unitUpdateFailures = 0;
  const perPlatform: Record<string, PlatformTickReport> = Object.create(null);
  const platforms = [...byPlatform.entries()].sort(([left], [right]) => compareStrings(left, right));

  await mapConcurrent(platforms, platformConcurrency, async ([platform, units]) => {
    const uniqueUsers = new Set(
      units.flatMap((unit) => unit.subscribers.map((recipient) => recipient.userId)),
    );
    const budget = uniqueUsers.size * ports.queriesPerUserPerTick;
    if (!Number.isSafeInteger(budget)) {
      throw new RangeError('Invalid scheduler budget: calculated platform budget exceeds the maximum safe integer.');
    }

    const selected = pickDueUnits(
      units.map((unit) => ({
        unitId: unit.unitId,
        platform: unit.platform,
        subscribers: unit.subscribers.map((recipient) => recipient.userId),
        nextRunAt: unit.nextRunAt,
      })),
      budget,
      now,
    );
    const unitsById = new Map(units.map((unit) => [unit.unitId, unit]));
    const chosen = selected.map((selectedUnit) => unitsById.get(selectedUnit.unitId)!);
    if (chosen.length === 0) {
      perPlatform[platform] = Object.freeze({ units: 0, discovered: 0 });
      return;
    }

    const plan: SearchPlan<unknown> = Object.freeze({
      searches: Object.freeze(chosen.map((unit) => Object.freeze({
        search: unit.query,
        recipients: unit.subscribers,
      }))),
    });

    let discovery: TickDiscovery;
    try {
      discovery = await ports.discover(platform, plan);
    } catch {
      // Advancing cadence after provider failure would silently skip an entire discovery period.
      platformFailures += 1;
      return;
    }

    for (const unit of chosen) {
      const name = representativeSearchName(unit.query);
      const perSearch = discovery.discoveredBySearch;
      const foundNovelty = name !== null && perSearch !== undefined && Object.hasOwn(perSearch, name)
        ? perSearch[name]! > 0
        : discovery.discovered > 0;
      try {
        await ports.recordUnitRun(
          unit.unitId,
          nextCadence(unit.cadenceMinutes, foundNovelty, ports.cadencePolicy),
          foundNovelty,
          now,
        );
        unitsRun += 1;
      } catch {
        unitUpdateFailures += 1;
      }
    }
    perPlatform[platform] = Object.freeze({ units: chosen.length, discovered: discovery.discovered });
  });

  return Object.freeze({
    due: due.length,
    unitsRun,
    platformFailures,
    unitUpdateFailures,
    perPlatform: Object.freeze(perPlatform),
  });
}

const wakeFloorMs = 15_000;
const wakeCeilingMs = 5 * 60_000;

/** Sleeps near the earliest schedule while retaining bounded retry and idle responsiveness. */
export function nextWakeMs(units: readonly Pick<TickUnit, 'nextRunAt'>[], now: Date): number {
  const nowMs = validDate(now, 'now');
  if (units.length === 0) return wakeCeilingMs;
  const timestamps = units.map((unit) => validDate(unit.nextRunAt, 'unit nextRunAt'));
  return Math.min(wakeCeilingMs, Math.max(wakeFloorMs, Math.min(...timestamps) - nowMs));
}

export interface MatchEvidence {
  readonly score: number;
  readonly regexScore: number;
  readonly lexicalCosine: number;
  readonly titleSimilarity: number;
  readonly skillCoverage: number;
  readonly seniorityGap: number | null;
  readonly specificity: number | null;
  readonly lexicalCosineIdf: number | null;
}

export interface MatchCandidateInput extends MatchEvidence {
  readonly userId: UserId;
  readonly vacancyId: number;
}

export interface MatchPorts {
  approvedUserIds(): Promise<readonly UserId[]>;
  lexicalScore(userId: UserId, vacancy: unknown): Promise<MatchEvidence | null>;
  readonly matchFloor: number;
  createMatches(candidates: readonly MatchCandidateInput[], now: Date): Promise<number>;
}

export interface MatchReport {
  readonly evaluated: number;
  readonly matched: number;
  readonly failures: number;
}

function assertScore(value: number, name: string, maximum = 100): void {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new RangeError(`Invalid match evidence ${name}: expected a finite number from 0 through ${maximum}.`);
  }
}

function assertNullableUnitInterval(value: number | null, name: string): void {
  if (value !== null) assertScore(value, name, 1);
}

function assertMatchEvidence(evidence: MatchEvidence): void {
  assertScore(evidence.score, 'score');
  assertScore(evidence.regexScore, 'regexScore');
  assertScore(evidence.lexicalCosine, 'lexicalCosine', 1);
  assertScore(evidence.titleSimilarity, 'titleSimilarity', 1);
  assertScore(evidence.skillCoverage, 'skillCoverage', 1);
  assertNullableUnitInterval(evidence.specificity, 'specificity');
  assertNullableUnitInterval(evidence.lexicalCosineIdf, 'lexicalCosineIdf');
  if (evidence.seniorityGap !== null
    && (!Number.isFinite(evidence.seniorityGap) || evidence.seniorityGap < -1 || evidence.seniorityGap > 1)) {
    throw new RangeError('Invalid match evidence seniorityGap: expected null or a finite number from -1 through 1.');
  }
}

/** Evaluates every approved user's lens independently and persists only evidence meeting the configured floor. */
export async function matchVacancy(
  ports: MatchPorts,
  vacancy: { readonly vacancyId: number },
  now: Date,
): Promise<MatchReport> {
  validDate(now, 'now');
  assertScore(ports.matchFloor, 'floor');
  assertPositiveSafeInteger(vacancy.vacancyId, 'vacancy ID');
  const users = await ports.approvedUserIds();
  if (new Set(users).size !== users.length) {
    throw new TypeError('Invalid match input: approved user list contains duplicate user IDs.');
  }

  const candidates: MatchCandidateInput[] = [];
  let failures = 0;
  for (const userId of users) {
    try {
      const evidence = await ports.lexicalScore(userId, vacancy);
      if (evidence === null) continue;
      assertMatchEvidence(evidence);
      if (evidence.score >= ports.matchFloor) {
        candidates.push(Object.freeze({ userId, vacancyId: vacancy.vacancyId, ...evidence }));
      }
    } catch {
      failures += 1;
    }
  }

  const matched = candidates.length > 0
    ? await ports.createMatches(Object.freeze(candidates), now)
    : 0;
  return Object.freeze({ evaluated: users.length, matched, failures });
}
