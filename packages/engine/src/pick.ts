/**
 * Selects which due units a tick actually runs. Users before breadth: every subscriber of any due unit gets their
 * most overdue unit first, so no one waits because somebody else's niche is busy; remaining budget then goes to the
 * most overdue units regardless of owner. Deterministic given the inputs — ties break by unit id.
 */
export interface SchedulableUnit {
  unitId: string;
  platform: string;
  subscribers: readonly string[];
  nextRunAt: number;
}

export function pickDueUnits(units: readonly SchedulableUnit[], budget: number, now: number): SchedulableUnit[] {
  const due = units.filter((unit) => unit.nextRunAt <= now && unit.subscribers.length > 0)
    .sort((left, right) => left.nextRunAt - right.nextRunAt || left.unitId.localeCompare(right.unitId));
  if (due.length <= budget) return due;

  const picked = new Map<string, SchedulableUnit>();
  const covered = new Set<string>();
  const users = [...new Set(due.flatMap((unit) => unit.subscribers))].sort();
  for (const userId of users) {
    if (picked.size >= budget) break;
    if (covered.has(userId)) continue;
    const unit = due.find((candidate) => !picked.has(candidate.unitId) && candidate.subscribers.includes(userId));
    if (!unit) continue;
    picked.set(unit.unitId, unit);
    for (const subscriber of unit.subscribers) covered.add(subscriber);
  }
  for (const unit of due) {
    if (picked.size >= budget) break;
    if (!picked.has(unit.unitId)) picked.set(unit.unitId, unit);
  }
  return [...picked.values()];
}
