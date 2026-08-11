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
  regexScore?: number; lexicalCosine?: number; titleSimilarity?: number; skillCoverage?: number;
  /** Null is meaningful here: neither side named a grade, which is not the same as the grades agreeing. */
  seniorityGap?: number | null;
  /** Null means no rarity vocabulary existed when this was measured, which is not the same as zero rarity. */
  specificity?: number | null;
  lexicalCosineIdf?: number | null;
}

/** Ingest: new matches appear as 'matched'; an existing row is never touched — delivery memory is append-only here. */
export async function createMatches(candidates: readonly MatchCandidate[], now: Date): Promise<number> {
  let created = 0;
  for (const candidate of candidates) {
    const rows = await q(`insert into matches (user_id, vacancy_id, state, lexical_score, lexical_regex_score,
        lexical_cosine, lexical_title_similarity, lexical_skill_coverage, lexical_seniority_gap,
        lexical_specificity, lexical_cosine_idf, matched_at, updated_at)
      values ($1, $2, 'matched', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) on conflict (user_id, vacancy_id) do nothing returning vacancy_id`,
      [candidate.userId, candidate.vacancyId, candidate.lexicalScore, candidate.regexScore ?? null,
        candidate.lexicalCosine ?? null, candidate.titleSimilarity ?? null, candidate.skillCoverage ?? null,
        candidate.seniorityGap ?? null, candidate.specificity ?? null, candidate.lexicalCosineIdf ?? null,
        now.toISOString()]);
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

/**
 * One match waiting on the budget, carrying the evidence frozen at match time.
 *
 * The store hands these back unranked. Application code orders by semantic score, with raw evidence as fallback.
 */
export interface PendingMatch {
  vacancyId: number;
  matchedAt: string;
  source: string;
  publishedAt: string;
  /** Null on rows written before the column existed; the caller reads that as no contribution. */
  regexScore: number | null;
  lexicalCosine: number | null;
  titleSimilarity: number | null;
  skillCoverage: number | null;
  seniorityGap: number | null;
  specificity: number | null;
  lexicalCosineIdf: number | null;
  /** Cheap semantic prescore. Null means the optional prescoring model has not judged this row yet. */
  prescoreScore?: number | null;
  /** A below-threshold row frozen into the exploration sample for independent shadow labels. */
  prescoreExploration?: boolean;
}

/**
 * Everything this user has waiting, for the caller to rank.
 *
 * A row whose updated_at outruns matched_at came back from a failed scoring batch (or a content reset); it sits
 * out a cooldown before it is offered again, so a batch that fails persistently cannot monopolize the head of
 * the best-first queue — everything below it gets scored while it waits.
 *
 * `cap` bounds the fetch, not the claim. It is deliberately far above any real backlog: whatever it cuts off is
 * invisible to the ranking, so a cap that bites is a silent ordering error rather than a slow query.
 */
export async function pendingMatchesForScoring(userId: string, cap: number,
  requiredPrescoreModel: string | null = null, requiredPromptVersion = 1,
  minimumPrescore = 0): Promise<PendingMatch[]> {
  const rows = await q(`select m.vacancy_id, m.matched_at, m.lexical_regex_score, m.lexical_cosine,
      m.lexical_title_similarity, m.lexical_skill_coverage, m.lexical_seniority_gap, m.lexical_specificity,
      m.lexical_cosine_idf, m.prescore_score, m.prescore_exploration, v.source, v.published_at
    from matches m join vacancies v on v.id = m.vacancy_id
    where m.user_id = $1 and m.state = 'matched'
      and ($3::text is null or (m.prescore_score is not null and m.prescore_model = $3
        and m.prescore_prompt_version = $4
        and (m.prescore_score >= $5 or m.prescore_exploration = true)))
      and (m.updated_at <= m.matched_at or m.updated_at < now() - interval '6 hours')
    order by m.matched_at desc limit $2`,
    [userId, cap, requiredPrescoreModel, requiredPromptVersion, minimumPrescore]);
  return rows.map((row) => ({
    vacancyId: Number(row.vacancy_id),
    matchedAt: new Date(row.matched_at as string).toISOString(),
    source: String(row.source),
    publishedAt: new Date(row.published_at as string).toISOString(),
    regexScore: row.lexical_regex_score == null ? null : Number(row.lexical_regex_score),
    lexicalCosine: row.lexical_cosine == null ? null : Number(row.lexical_cosine),
    titleSimilarity: row.lexical_title_similarity == null ? null : Number(row.lexical_title_similarity),
    skillCoverage: row.lexical_skill_coverage == null ? null : Number(row.lexical_skill_coverage),
    seniorityGap: row.lexical_seniority_gap == null ? null : Number(row.lexical_seniority_gap),
    specificity: row.lexical_specificity == null ? null : Number(row.lexical_specificity),
    lexicalCosineIdf: row.lexical_cosine_idf == null ? null : Number(row.lexical_cosine_idf),
    prescoreScore: row.prescore_score == null ? null : Number(row.prescore_score),
    prescoreExploration: Boolean(row.prescore_exploration),
  }));
}

/** Rows that need the optional cheap semantic pass before full-scoring admission. */
export async function pendingMatchesForPrescoring(userId: string, cap: number, model: string,
  promptVersion: number): Promise<number[]> {
  const rows = await q(`select vacancy_id from matches where user_id = $1 and state = 'matched'
      and llm_score is null
      and (prescore_score is null or prescore_model is distinct from $3
        or prescore_prompt_version is distinct from $4)
      and (updated_at <= matched_at or updated_at < now() - interval '6 hours')
    order by matched_at desc limit $2`, [userId, cap, model, promptVersion]);
  return rows.map((row) => Number(row.vacancy_id));
}

/** Lands a cheap semantic verdict and releases its temporary claim back to the full-scoring queue. */
export async function savePrescore(userId: string, vacancyId: number, score: number, model: string,
  promptVersion: number, exploration: boolean, now = new Date()): Promise<boolean> {
  const rows = await q(`update matches set state = 'matched', updated_at = matched_at,
      prescore_score = $3, prescore_model = $4,
      prescore_prompt_version = $5, prescore_updated_at = $6, prescore_exploration = $7
    where user_id = $1 and vacancy_id = $2 and state = 'queued' and llm_score is null
    returning vacancy_id`, [userId, vacancyId, score, model, promptVersion, now.toISOString(), exploration]);
  return rows.length > 0;
}

/**
 * Takes the named matches for scoring, and reports which were actually taken.
 *
 * `state = 'matched'` in the predicate is the whole concurrency story: a row another claim already moved is not
 * matched any more, so it cannot be taken twice. A caller that asked for ten and got eight raced someone and
 * lost two, which is correct and needs no lock.
 */
export async function claimMatches(userId: string, vacancyIds: readonly number[]): Promise<number[]> {
  if (!vacancyIds.length) return [];
  const rows = await q(`update matches set state = 'queued', updated_at = now()
    where user_id = $1 and vacancy_id = any($2::bigint[]) and state = 'matched'
    returning vacancy_id`, [userId, [...vacancyIds]]);
  return rows.map((row) => Number(row.vacancy_id));
}

/** How many verdicts this user has of their own — the evidence any ordering for them is founded on. */
export async function scoredMatchCount(userId: string): Promise<number> {
  const rows = await q(`select count(*) n from matches where user_id = $1 and llm_score is not null`, [userId]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Retires matches whose advert outlived the prefilter's age limit before anyone judged them.
 *
 * Only 'matched' rows are touched: 'queued' means a scorer holds a claim, and racing it would lose a verdict
 * already paid for. The prefilter refuses to admit an advert this old in the first place, so a match still
 * waiting past the limit is one the budget never reached — the state machine already allows matched -> expired,
 * nothing was writing it, and the difference between "passed over" and "still pending" was invisible.
 */
export async function expireStaleMatches(maxAgeDays: number, now: Date): Promise<number> {
  const rows = await q(`update matches m set state = 'expired', updated_at = $2
    from vacancies v
    where v.id = m.vacancy_id and m.state = 'matched' and m.llm_score is null
      and v.published_at < $2::timestamptz - make_interval(days => $1::int)
    returning m.vacancy_id`, [maxAgeDays, now.toISOString()]);
  return rows.length;
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

export type IdfScope = 'title' | 'body';
export interface StoredIdfVocabulary {
  entries: { token: string; idf: number }[];
  documents: number;
  unknownIdf: number;
}

/**
 * Swaps in a freshly built vocabulary.
 *
 * One transaction, and the rows go in through `unnest` rather than a statement each: the body scope is tens of
 * thousands of tokens, and a per-row insert loop turns a rebuild into minutes of round trips on a hosted
 * database. Chunked so a single statement never carries an unbounded parameter array.
 */
export async function replaceIdfVocabulary(scope: IdfScope, vocabulary: StoredIdfVocabulary): Promise<void> {
  const chunk = 5_000;
  await withPostgresTransaction(async (client) => {
    await client.query('delete from idf_vocabulary where scope = $1', [scope]);
    for (let offset = 0; offset < vocabulary.entries.length; offset += chunk) {
      const slice = vocabulary.entries.slice(offset, offset + chunk);
      await client.query(`insert into idf_vocabulary (scope, token, idf)
        select $1, * from unnest($2::text[], $3::float8[])`,
      [scope, slice.map((entry) => entry.token), slice.map((entry) => entry.idf)]);
    }
    await client.query(`insert into idf_corpora (scope, documents, tokens, unknown_idf, updated_at)
      values ($1, $2, $3, $4, now())
      on conflict (scope) do update set documents = excluded.documents, tokens = excluded.tokens,
        unknown_idf = excluded.unknown_idf, updated_at = excluded.updated_at`,
    [scope, vocabulary.documents, vocabulary.entries.length, vocabulary.unknownIdf]);
  });
}

/** Null when this scope has never been built — which the caller must not confuse with an empty corpus. */
export async function loadIdfVocabulary(scope: IdfScope): Promise<StoredIdfVocabulary | null> {
  const corpus = await q(`select documents, unknown_idf from idf_corpora where scope = $1`, [scope]);
  if (!corpus.length) return null;
  const rows = await q(`select token, idf from idf_vocabulary where scope = $1`, [scope]);
  return {
    entries: rows.map((row) => ({ token: String(row.token), idf: Number(row.idf) })),
    documents: Number(corpus[0]!.documents),
    unknownIdf: Number(corpus[0]!.unknown_idf),
  };
}

/** Advert text for a vocabulary rebuild, in batches, so a rebuild never holds the whole corpus in memory. */
export async function vacancyTextBatch(afterId: number, limit: number):
Promise<{ id: number; name: string; description: string; keySkills: string[] }[]> {
  const rows = await q(`select id, name, description, key_skills_json from vacancies
    where id > $1 order by id limit $2`, [afterId, limit]);
  return rows.map((row) => ({
    id: Number(row.id), name: String(row.name ?? ''), description: String(row.description ?? ''),
    keySkills: Array.isArray(row.key_skills_json) ? (row.key_skills_json as unknown[]).map(String) : [],
  }));
}
