/**
 * Repositories for the engine schema (search_units, unit_subscriptions, matches, accounts). They coexist with the
 * legacy repositories until cutover; only engine-runtime code reaches them. Match-state transitions are enforced in
 * the update's where-clause — a lost race means zero rows, never a corrupted state.
 */
import {
  assertTransition, type CompiledSubscription, type CompiledUnit, type MatchState, type RoleEquivalencePair,
} from '@jobseeker/engine';
import { postgresQuery as q, withPostgresTransaction } from './client.ts';

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

/** The loop's sleep horizon: when the earliest live unit wants to run. */
export async function nextUnitDueAt(): Promise<Date | null> {
  const rows = await q(`select min(next_run_at) due from search_units where retired_at is null`);
  return rows[0]?.due ? new Date(rows[0].due as string) : null;
}

export async function recordUnitRun(unitId: string, cadenceMinutes: number, foundNovelty: boolean,
  now: Date): Promise<void> {
  await q(`update search_units set cadence_minutes = $2, last_run_at = $3,
      last_novelty_at = case when $4 then $3 else last_novelty_at end,
      next_run_at = $3::timestamptz + make_interval(mins => $2)
    where unit_id = $1`, [unitId, cadenceMinutes, now.toISOString(), foundNovelty]);
}

/** The live unit population, as compile-time adoption needs it: a new search may join any of these. */
export async function existingCompiledUnits(): Promise<CompiledUnit[]> {
  const rows = await q(`select unit_id, platform, filter_signature, canonical_tokens, query
    from search_units where retired_at is null`);
  return rows.map((row) => ({ unitId: String(row.unit_id), platform: String(row.platform),
    filterSignature: String(row.filter_signature), canonicalTokens: (row.canonical_tokens as string[]) ?? [],
    query: row.query }));
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

export interface MatchCandidate {
  userId: string; vacancyId: number; lexicalScore: number;
  /** Prefilter evidence frozen at match time — the future training row once the LLM judges this match. */
  regexScore?: number; lexicalCosine?: number;
}

/** Ingest: new matches appear as 'matched'; an existing row is never touched — delivery memory is append-only here. */
export async function createMatches(candidates: readonly MatchCandidate[], now: Date): Promise<number> {
  let created = 0;
  for (const candidate of candidates) {
    const rows = await q(`insert into matches (user_id, vacancy_id, state, lexical_score, lexical_regex_score,
        lexical_cosine, matched_at, updated_at)
      values ($1, $2, 'matched', $3, $4, $5, $6, $6) on conflict (user_id, vacancy_id) do nothing returning vacancy_id`,
      [candidate.userId, candidate.vacancyId, candidate.lexicalScore, candidate.regexScore ?? null,
        candidate.lexicalCosine ?? null, now.toISOString()]);
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

/** A scored match whose evidence was frozen at match time — one calibration training row. */
export interface CalibrationExampleRow {
  regexScore: number; lexicalCosine: number; source: string; llmScore: number; storedLexicalScore: number;
  publishedAt: string; scoreUpdatedAt: string;
}

export async function calibrationExamples(limit = 20_000): Promise<CalibrationExampleRow[]> {
  const rows = await q(`select m.lexical_regex_score, m.lexical_cosine, m.lexical_score, m.llm_score,
      m.score_updated_at, v.source, v.published_at
    from matches m join vacancies v on v.id = m.vacancy_id
    where m.llm_score is not null and m.lexical_regex_score is not null and m.lexical_cosine is not null
      and m.score_updated_at is not null
    order by m.score_updated_at desc limit $1`, [limit]);
  return rows.map((row) => ({ regexScore: Number(row.lexical_regex_score), lexicalCosine: Number(row.lexical_cosine),
    source: String(row.source), llmScore: Number(row.llm_score), storedLexicalScore: Number(row.lexical_score ?? 0),
    publishedAt: new Date(row.published_at as string).toISOString(),
    scoreUpdatedAt: new Date(row.score_updated_at as string).toISOString() }));
}

export interface StoredCalibrationRow { id: number; createdAt: string; coefficients: unknown; accepted: boolean }

/** The newest accepted calibration — the model that orders scoring claims right now. */
export async function activeStoredCalibration(): Promise<StoredCalibrationRow | null> {
  const rows = await q(`select id, created_at, coefficients, accepted from calibrations
    where accepted = 1 order by id desc limit 1`);
  return rows[0] ? rowToCalibration(rows[0]) : null;
}

/** When any refit last ran, accepted or not — the cadence gate, so a rejected fit is not retried every tick. */
export async function latestCalibrationAttemptAt(): Promise<string | null> {
  const rows = await q(`select max(created_at) at from calibrations`);
  return rows[0]?.at ? new Date(rows[0].at as string).toISOString() : null;
}

/** Labels that arrived after the active model was fitted — the evidence a refit would newly learn from. */
export async function calibrationLabelsSince(timestamp: string | null): Promise<number> {
  const rows = await q(`select count(*) n from matches where llm_score is not null
    and lexical_regex_score is not null and ($1::timestamptz is null or score_updated_at > $1::timestamptz)`,
    [timestamp]);
  return Number(rows[0]?.n ?? 0);
}

export async function saveCalibration(coefficients: unknown, metrics: unknown,
  accepted: boolean): Promise<void> {
  await q(`insert into calibrations (coefficients, metrics, accepted) values ($1::jsonb, $2::jsonb, $3)`,
    [JSON.stringify(coefficients), JSON.stringify(metrics), accepted ? 1 : 0]);
}

/** Mining recomputes from all profiles, so the table is replaced wholesale — derived data has no history. */
export async function replaceRoleEquivalences(pairs: readonly RoleEquivalencePair[]): Promise<void> {
  await withPostgresTransaction(async (client) => {
    await client.query('delete from role_equivalences');
    for (const pair of pairs) {
      await client.query(`insert into role_equivalences (token_a, token_b, support, updated_at)
        values ($1, $2, $3, now())`, [pair.tokenA, pair.tokenB, pair.support]);
    }
  });
}

export async function loadRoleEquivalences(minimumSupport = 1): Promise<RoleEquivalencePair[]> {
  const rows = await q(`select token_a, token_b, support from role_equivalences where support >= $1
    order by token_a, token_b`, [minimumSupport]);
  return rows.map((row) => ({ tokenA: String(row.token_a), tokenB: String(row.token_b),
    support: Number(row.support) }));
}

function rowToCalibration(row: Record<string, unknown>): StoredCalibrationRow {
  const coefficients = row.coefficients;
  return { id: Number(row.id), createdAt: new Date(row.created_at as string).toISOString(),
    coefficients: typeof coefficients === 'string' ? JSON.parse(coefficients) : coefficients,
    accepted: Number(row.accepted) === 1 };
}
