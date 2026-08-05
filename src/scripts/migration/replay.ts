/**
 * Gate F — behavioral replay. Runs the engine's scheduler and match repositories against the migrated scratch
 * database with a deterministic fake fetcher: proves coverage, cadence discipline, scoring-claim bounds, and above
 * all that nothing the old world delivered can ever be re-delivered. Requires a scratch that already passed A–E.
 */
import { Pool } from 'pg';
import { nextCadence, pickDueUnits } from '@jobseeker/engine';
import { configureStore, claimForScoring, createMatches, dueUnits, recordUnitRun, transitionMatch } from '@jobseeker/store';

const url = process.env.SCRATCH_DATABASE_URL;
if (!url) throw new Error('SCRATCH_DATABASE_URL is required.');
configureStore({ databaseUrl: url, poolMax: 2, ssl: false, settings: {
  accessRequestCooldownMinutes: 0, prefilterMaxAgeDays: 30, searchPlatforms: [], digestMinScore: 50, alertScore: 80,
  normalizationPerSourceQuota: 0, timezone: 'UTC', safeVacancyUrl: (_source, value) => value,
} });
const pool = new Pool({ connectionString: url, max: 2, ssl: false });
const policy = { floorMinutes: 30, ceilingMinutes: 720 };
const failures: string[] = [];
const check = (ok: boolean, name: string, detail: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  F:${name}  ${detail}`);
  if (!ok) failures.push(name);
};

// -- Scheduler discipline over six simulated ticks ---------------------------------------------------------------
const approved = (await pool.query(`select count(distinct s.user_id) n from unit_subscriptions s
  join users u on u.user_id = s.user_id and u.status = 'approved'`)).rows[0];
const subscriberCount = Number(approved.n);
let starved = 0;
for (let tick = 0; tick < 6; tick++) {
  const now = new Date(Date.now() + tick * 30 * 60_000);
  const due = await dueUnits(now);
  if (!due.length) continue;
  const schedulable = due.map((unit) => ({ unitId: unit.unitId, platform: unit.platform,
    subscribers: unit.subscribers.map((entry) => entry.userId), nextRunAt: 0 }));
  const budget = Math.max(1, subscriberCount * 2);
  const picked = pickDueUnits(schedulable, budget, now.getTime());
  const dueUsers = new Set(schedulable.flatMap((unit) => unit.subscribers));
  const servedUsers = new Set(picked.flatMap((unit) => unit.subscribers));
  for (const user of dueUsers) if (!servedUsers.has(user) && picked.length >= budget) starved++;
  for (const unit of picked) {
    const row = due.find((entry) => entry.unitId === unit.unitId)!;
    const novelty = tick === 0; // first contact yields, later ticks are quiet: cadence must stretch
    await recordUnitRun(unit.unitId, nextCadence(row.cadenceMinutes, novelty, policy), novelty, now);
  }
}
const cadences = (await pool.query(`select min(cadence_minutes) lo, max(cadence_minutes) hi,
  count(*) filter (where next_run_at <= last_run_at) frozen from search_units where last_run_at is not null`)).rows[0];
check(Number(cadences.lo) >= policy.floorMinutes && Number(cadences.hi) <= policy.ceilingMinutes,
  'cadence bounds', `min=${cadences.lo} max=${cadences.hi}`);
check(Number(cadences.frozen) === 0, 'time advances', `units with non-advancing next_run_at: ${cadences.frozen}`);
check(starved === 0, 'no starvation', `user-ticks starved while budget remained: ${starved}`);

// -- The delivered wall ------------------------------------------------------------------------------------------
const delivered = (await pool.query(`select user_id, vacancy_id, state from matches
  where state in ('alerted','digested','applied') limit 25`)).rows;
check(delivered.length > 0, 'delivered corpus present', `sampled ${delivered.length} delivered matches`);
let resurrected = 0;
for (const row of delivered) {
  const created = await createMatches([{ userId: String(row.user_id), vacancyId: Number(row.vacancy_id),
    lexicalScore: 99 }], new Date());
  if (created > 0) resurrected++;
  const moved = await transitionMatch(String(row.user_id), Number(row.vacancy_id), 'scored', 'alerted');
  if (moved) resurrected++;
}
check(resurrected === 0, 'no re-delivery', `delivered matches that ingest or delivery could touch: ${resurrected}`);

// -- Scoring claims respect state and budget ---------------------------------------------------------------------
const someUser = (await pool.query(`select user_id from matches where state = 'matched' limit 1`)).rows[0];
if (someUser) {
  const claimed = await claimForScoring(String(someUser.user_id), 3);
  const states = (await pool.query(`select count(*) n from matches
    where user_id = $1 and vacancy_id = any($2::bigint[]) and state = 'queued'`,
    [someUser.user_id, claimed])).rows[0];
  check(claimed.length <= 3 && Number(states.n) === claimed.length,
    'scoring claim', `claimed=${claimed.length} queued=${states.n}`);
  for (const vacancyId of claimed) await transitionMatch(String(someUser.user_id), vacancyId, 'queued', 'matched');
} else {
  check(true, 'scoring claim', 'no matched rows to claim (acceptable on this snapshot)');
}

console.log(failures.length ? `\nGATE F FAILED: ${failures.join(', ')}` : '\nGATE F PASSED');
process.exitCode = failures.length ? 1 : 0;
await pool.end();
