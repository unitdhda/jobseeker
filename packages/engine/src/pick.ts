import type { SourceKey, UserId } from './contracts.ts';
import type { SearchUnitId } from './identity.ts';

export interface SchedulableUnit {
  readonly unitId: SearchUnitId;
  readonly platform: SourceKey;
  /** Unique user IDs. Empty means the unit is not schedulable. */
  readonly subscribers: readonly UserId[];
  readonly nextRunAt: Date;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSchedule(
  left: { readonly unit: SchedulableUnit; readonly nextRunAtMs: number },
  right: { readonly unit: SchedulableUnit; readonly nextRunAtMs: number },
): number {
  return left.nextRunAtMs - right.nextRunAtMs || compareStrings(left.unit.unitId, right.unit.unitId);
}

function assertBudget(budget: number): void {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError(
      `Invalid scheduling budget: expected a nonnegative safe integer, received ${budget}.`,
    );
  }
}

function timestampOf(date: Date, name: string): number {
  if (!(date instanceof Date)) {
    throw new TypeError(`Invalid scheduling input: ${name} must be a Date.`);
  }
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`Invalid scheduling input: ${name} must be a valid Date.`);
  }
  return timestamp;
}

/** Selects due subscribed units, covering the most users possible before spending budget on overdue breadth. */
export function pickDueUnits(
  units: readonly SchedulableUnit[],
  budget: number,
  now: Date,
): readonly SchedulableUnit[] {
  assertBudget(budget);
  const nowMs = timestampOf(now, 'now');
  const unitIds = new Set<SearchUnitId>();
  const prepared: Array<{
    readonly unit: SchedulableUnit;
    readonly nextRunAtMs: number;
    readonly subscribers: ReadonlySet<UserId>;
  }> = [];

  for (const unit of units) {
    if (unitIds.has(unit.unitId)) {
      throw new TypeError('Invalid scheduling input: duplicate unit ID encountered.');
    }
    unitIds.add(unit.unitId);

    const nextRunAtMs = timestampOf(unit.nextRunAt, 'nextRunAt');
    const subscribers = new Set(unit.subscribers);
    if (subscribers.size !== unit.subscribers.length) {
      throw new TypeError('Invalid scheduling input: a unit contains duplicate subscribers.');
    }
    prepared.push({ unit, nextRunAtMs, subscribers });
  }

  if (budget === 0) return Object.freeze([]);

  const due = prepared
    .filter((entry) => entry.nextRunAtMs <= nowMs && entry.subscribers.size > 0)
    .sort(compareSchedule);
  if (due.length <= budget) return Object.freeze(due.map((entry) => entry.unit));

  const allUsers = new Set<UserId>();
  for (const entry of due) for (const userId of entry.subscribers) allUsers.add(userId);

  const uncovered = new Set(allUsers);
  const picked = new Set<SearchUnitId>();
  const selected: typeof due = [];

  while (selected.length < budget && uncovered.size > 0) {
    let best: (typeof due)[number] | undefined;
    let bestCoverage = 0;

    for (const candidate of due) {
      if (picked.has(candidate.unit.unitId)) continue;
      let coverage = 0;
      for (const userId of candidate.subscribers) if (uncovered.has(userId)) coverage += 1;
      if (coverage > bestCoverage
        || (coverage === bestCoverage && coverage > 0 && best !== undefined
          && compareSchedule(candidate, best) < 0)) {
        best = candidate;
        bestCoverage = coverage;
      }
    }

    if (!best || bestCoverage === 0) break;
    selected.push(best);
    picked.add(best.unit.unitId);
    for (const userId of best.subscribers) uncovered.delete(userId);
  }

  for (const entry of due) {
    if (selected.length >= budget) break;
    if (!picked.has(entry.unit.unitId)) selected.push(entry);
  }

  return Object.freeze(selected.map((entry) => entry.unit));
}
