/**
 * Repositories for the engine schema (search_units, unit_subscriptions, matches, accounts). They coexist with the
 * legacy repositories until cutover; only engine-runtime code reaches them. Match-state transitions are enforced in
 * the update's where-clause — a lost race means zero rows, never a corrupted state.
 */
import { assertTransition, type CompiledSubscription, type CompiledUnit, type MatchState } from '@jobseeker/engine';
import { postgresQuery as q } from './client.ts';

export interface DueUnitRow {
  unitId: string; platform: string; query: unknown; cadenceMinutes: number;
  subscribers: { userId: string; searchName: string }[];
}

export async function dueUnits(now: Date): Promise<DueUnitRow[]> {
  const rows = await q(`select u.unit_id, u.platform, u.query, u.cadence_minutes,
      jsonb_agg(jsonb_build_object('userId', s.user_id, 'searchName', s.search_name)) as subscribers
    from search_units u join unit_subscriptions s on s.unit_id = u.unit_id
    join users usr on usr.user_id = s.user_id and usr.status = 'approved'
    where u.retired_at is null and u.next_run_at <= $1
    group by u.unit_id`, [now.toISOString()]);
  return rows.map((row) => ({ unitId: String(row.unit_id), platform: String(row.platform), query: row.query,
    cadenceMinutes: Number(row.cadence_minutes), subscribers: row.subscribers as DueUnitRow['subscribers'] }));
}

export async function recordUnitRun(unitId: string, cadenceMinutes: number, foundNovelty: boolean,
  now: Date): Promise<void> {
  await q(`update search_units set cadence_minutes = $2, last_run_at = $3,
      last_novelty_at = case when $4 then $3 else last_novelty_at end,
      next_run_at = $3::timestamptz + make_interval(mins => $2)
    where unit_id = $1`, [unitId, cadenceMinutes, now.toISOString(), foundNovelty]);
}

/** Applies a demand compilation: new units and subscriptions land, vanished subscriptions retire their units. */
export async function applyDemand(userId: string, units: readonly CompiledUnit[],
  subscriptions: readonly CompiledSubscription[], initialCadenceMinutes: number): Promise<void> {
  for (const unit of units) {
    await q(`insert into search_units (unit_id, platform, filter_signature, canonical_tokens, query,
        cadence_minutes, next_run_at)
      values ($1, $2, $3, $4, $5::jsonb, $6, now())
      on conflict (unit_id) do update set retired_at = null`,
      [unit.unitId, unit.platform, unit.filterSignature, unit.canonicalTokens, JSON.stringify(unit.query),
        initialCadenceMinutes]);
  }
  const kept = subscriptions.filter((subscription) => subscription.userId === userId);
  for (const subscription of kept) {
    await q(`insert into unit_subscriptions (unit_id, user_id, search_name, source_search)
      values ($1, $2, $3, $4::jsonb) on conflict (unit_id, user_id) do update set
        search_name = excluded.search_name, source_search = excluded.source_search`,
      [subscription.unitId, subscription.userId, subscription.searchName || 'search',
        JSON.stringify(subscription.sourceSearch)]);
  }
  await q(`delete from unit_subscriptions where user_id = $1 and unit_id <> all($2::text[])`,
    [userId, kept.map((subscription) => subscription.unitId)]);
  await q(`update search_units u set retired_at = coalesce(u.retired_at, now())
    where not exists (select 1 from unit_subscriptions s where s.unit_id = u.unit_id)`);
}

export async function activeUnitQueries(platform: string): Promise<unknown[]> {
  return (await q(`select u.query from search_units u where u.platform = $1 and u.retired_at is null
    order by (select count(*) from unit_subscriptions s where s.unit_id = u.unit_id) desc, u.unit_id`, [platform]))
    .map((row) => row.query);
}

export interface MatchCandidate { userId: string; vacancyId: number; lexicalScore: number }

/** Ingest: new matches appear as 'matched'; an existing row is never touched — delivery memory is append-only here. */
export async function createMatches(candidates: readonly MatchCandidate[], now: Date): Promise<number> {
  let created = 0;
  for (const candidate of candidates) {
    const rows = await q(`insert into matches (user_id, vacancy_id, state, lexical_score, matched_at, updated_at)
      values ($1, $2, 'matched', $3, $4, $4) on conflict (user_id, vacancy_id) do nothing returning vacancy_id`,
      [candidate.userId, candidate.vacancyId, candidate.lexicalScore, now.toISOString()]);
    created += rows.length;
  }
  return created;
}

export async function transitionMatch(userId: string, vacancyId: number, from: MatchState, to: MatchState,
  patch: Record<string, unknown> = {}): Promise<boolean> {
  assertTransition(from, to);
  const columns = Object.keys(patch);
  const sets = columns.map((column, index) => `${column} = $${index + 5}`).join(', ');
  const rows = await q(`update matches set state = $4, updated_at = now()${columns.length ? `, ${sets}` : ''}
    where user_id = $1 and vacancy_id = $2 and state = $3 returning vacancy_id`,
    [userId, vacancyId, from, to, ...columns.map((column) => patch[column])]);
  return rows.length > 0;
}

export async function claimForScoring(userId: string, limit: number): Promise<number[]> {
  const rows = await q(`update matches set state = 'queued', updated_at = now()
    where (user_id, vacancy_id) in (
      select user_id, vacancy_id from matches where user_id = $1 and state = 'matched'
      order by lexical_score desc nulls last, matched_at desc limit $2 for update skip locked)
    returning vacancy_id`, [userId, limit]);
  return rows.map((row) => Number(row.vacancy_id));
}

export async function addSpend(userId: string, day: string, costUsd: number, kind: 'scores' | 'applications' | 'search_profiles'): Promise<void> {
  await q(`insert into accounts (user_id, day, llm_cost_usd, ${kind})
    values ($1, $2, $3, 1)
    on conflict (user_id, day) do update set llm_cost_usd = accounts.llm_cost_usd + $3,
      ${kind} = accounts.${kind} + 1, updated_at = now()`, [userId, day, costUsd]);
}

export async function spentToday(userId: string, day: string): Promise<number> {
  const rows = await q(`select llm_cost_usd from accounts where user_id = $1 and day = $2`, [userId, day]);
  return Number(rows[0]?.llm_cost_usd ?? 0);
}
