import assert from 'node:assert/strict';
import test from 'node:test';
import { matchVacancy, nextWakeMs, runSchedulerTick, type TickPorts } from '@jobseeker/engine';

const policy = { floorMinutes: 30, ceilingMinutes: 720 };

function fixture(overrides: Partial<TickPorts> = {}): { ports: TickPorts; ran: unknown[]; recorded: unknown[] } {
  const ran: unknown[] = [];
  const recorded: unknown[] = [];
  const units = [
    { unitId: 'a', platform: 'hh', query: { name: 'ML', text: 'ml' }, cadenceMinutes: 60,
      subscribers: [{ userId: 'u1', searchName: 'My ML' }, { userId: 'u2', searchName: 'МО' }] },
    { unitId: 'b', platform: 'hh', query: { name: 'Design', text: 'design' }, cadenceMinutes: 60,
      subscribers: [{ userId: 'u3', searchName: 'Дизайн' }] },
    { unitId: 'c', platform: 'habr', query: { name: 'Java', query: 'java' }, cadenceMinutes: 120,
      subscribers: [{ userId: 'u1', searchName: 'Java' }] },
  ];
  const ports: TickPorts = {
    cadencePolicy: policy,
    queriesPerUserPerTick: 1,
    dueUnits: async () => units,
    discover: async (platform, plan) => {
      ran.push({ platform, searches: plan.searches.map((entry) => entry.search) });
      // hh yields only for the ML search; habr is quiet.
      const discoveredBySearch: Record<string, number> = platform === 'hh' ? { ML: 2, Design: 0 } : {};
      const discovered = Object.values(discoveredBySearch).reduce((sum, n) => sum + n, 0);
      return { searches: plan.searches.length, users: 0, seen: 10, discovered, discoveredBySearch };
    },
    recordUnitRun: async (unitId, cadenceMinutes, foundNovelty) => { recorded.push({ unitId, cadenceMinutes, foundNovelty }); },
    ...overrides,
  };
  return { ports, ran, recorded };
}

test('a tick runs due units per platform and each recipient keeps their own search name', async () => {
  const { ports, ran } = fixture();
  const report = await runSchedulerTick(ports, new Date(0));
  assert.equal(report.unitsRun, 3);
  const hh = ran.find((entry: any) => entry.platform === 'hh') as any;
  assert.equal(hh.searches.length, 2, 'both hh units fetch in one platform plan');
  // The recipients handed to adapters must speak each user's language, not the unit representative's.
  const plans = (await ports.dueUnits(new Date(0)));
  assert.deepEqual(plans[0]!.subscribers.map((s) => s.searchName), ['My ML', 'МО']);
});

test('novelty adapts cadence per unit: yielding units tighten, quiet units stretch, all within bounds', async () => {
  const { ports, recorded } = fixture();
  await runSchedulerTick(ports, new Date(0));
  const byId = Object.fromEntries((recorded as any[]).map((entry) => [entry.unitId, entry]));
  assert.equal(byId.a.foundNovelty, true, 'ML yielded');
  assert.equal(byId.a.cadenceMinutes, 30, '60 halves to the floor');
  assert.equal(byId.b.foundNovelty, false, 'Design was quiet');
  assert.equal(byId.b.cadenceMinutes, 90, '60 stretches');
  assert.equal(byId.c.cadenceMinutes, 180, 'quiet habr unit stretches from 120');
});

test('a platform whose adapter throws does not take the tick down, and its units are not rescheduled blindly', async () => {
  const { ports, recorded } = fixture({
    discover: async (platform) => {
      if (platform === 'hh') throw new Error('hh is down');
      return { searches: 1, users: 0, seen: 0, discovered: 0, discoveredBySearch: {} };
    },
  });
  const report = await runSchedulerTick(ports, new Date(0));
  assert.equal(report.platformFailures, 1);
  const ids = (recorded as any[]).map((entry) => entry.unitId).sort();
  assert.deepEqual(ids, ['c'], 'only the healthy platform advances its units');
});

test('the wake-up clamps to sane bounds around the earliest due unit', () => {
  const minute = 60_000;
  assert.equal(nextWakeMs([{ nextRunAt: Date.parse('2026-01-01T00:02:00Z') }], Date.parse('2026-01-01T00:00:00Z')),
    2 * minute);
  assert.equal(nextWakeMs([{ nextRunAt: 0 }], Date.parse('2026-01-01T00:00:00Z')), 15_000, 'overdue floors at 15s');
  assert.equal(nextWakeMs([], Date.parse('2026-01-01T00:00:00Z')), 5 * minute, 'idle caps at 5 minutes');
});

test('match-on-ingest scores every approved user with their own lens and files only above the floor', async () => {
  const filed: unknown[] = [];
  const result = await matchVacancy({
    approvedUserIds: async () => ['u1', 'u2', 'u3'],
    lexicalScore: async (userId) => ({ score: ({ u1: 40, u2: 12, u3: 55 })[userId]!, regexScore: 30, lexicalCosine: 0.1 }),
    matchFloor: 20,
    createMatches: async (candidates) => { filed.push(...candidates); return candidates.length; },
  }, { vacancyId: 7 }, new Date(0));
  assert.equal(result.evaluated, 3);
  assert.deepEqual((filed as any[]).map((entry) => entry.userId).sort(), ['u1', 'u3'], 'u2 is below the floor');
  assert.ok((filed as any[]).every((entry) => entry.vacancyId === 7));
});

test('one user\'s scorer failure does not cost the others their match', async () => {
  const filed: unknown[] = [];
  const result = await matchVacancy({
    approvedUserIds: async () => ['u1', 'u2'],
    lexicalScore: async (userId) => {
      if (userId === 'u1') throw new Error('bad vocabulary');
      return { score: 90, regexScore: 75, lexicalCosine: 0.2 };
    },
    matchFloor: 20,
    createMatches: async (candidates) => { filed.push(...candidates); return candidates.length; },
  }, { vacancyId: 9 }, new Date(0));
  assert.equal(result.failures, 1);
  assert.deepEqual((filed as any[]).map((entry) => entry.userId), ['u2']);
});

test('platform scrapes overlap under platformConcurrency and stay sequential at the default', async () => {
  const order: string[] = [];
  const gate: { release?: () => void } = {};
  const slowFirst = (platform: string): Promise<void> => {
    order.push(`start:${platform}`);
    if (platform === 'hh') return new Promise((resolve) => { gate.release = () => { order.push('finish:hh'); resolve(); }; });
    order.push(`finish:${platform}`);
    return Promise.resolve();
  };

  // Concurrency 2: habr must start while hh is still in flight, and hh's failure to finish first must not matter.
  const concurrent = fixture({
    platformConcurrency: 2,
    discover: async (platform, plan) => {
      const pending = slowFirst(platform);
      if (platform === 'habr') gate.release?.();
      await pending;
      return { searches: plan.searches.length, users: 0, seen: 0, discovered: 0 };
    },
  });
  const report = await runSchedulerTick(concurrent.ports, new Date(0));
  assert.equal(report.unitsRun, 3);
  assert.deepEqual(order.slice(0, 2), ['start:hh', 'start:habr'], 'second platform started before the first finished');
  assert.ok(order.indexOf('finish:hh') > order.indexOf('start:habr'));

  // Default (no option): strictly sequential — habr starts only after hh finished.
  const sequentialOrder: string[] = [];
  const sequential = fixture({
    discover: async (platform, plan) => {
      sequentialOrder.push(`start:${platform}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sequentialOrder.push(`finish:${platform}`);
      return { searches: plan.searches.length, users: 0, seen: 0, discovered: 0 };
    },
  });
  await runSchedulerTick(sequential.ports, new Date(0));
  assert.deepEqual(sequentialOrder, ['start:hh', 'finish:hh', 'start:habr', 'finish:habr']);
});

test('a failing platform under concurrency is isolated and the others still record runs', async () => {
  const { ports, recorded } = fixture({
    platformConcurrency: 4,
    discover: async (platform, plan) => {
      if (platform === 'hh') throw new Error('browser exploded');
      return { searches: plan.searches.length, users: 0, seen: 0, discovered: 1 };
    },
  });
  const report = await runSchedulerTick(ports, new Date(0));
  assert.equal(report.platformFailures, 1);
  assert.equal(report.unitsRun, 1);
  assert.deepEqual((recorded as { unitId: string }[]).map((entry) => entry.unitId), ['c']);
  assert.equal(report.perPlatform.habr!.discovered, 1);
  assert.equal(report.perPlatform.hh, undefined);
});
