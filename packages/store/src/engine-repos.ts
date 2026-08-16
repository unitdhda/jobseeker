import type { PoolClient, QueryResultRow } from 'pg';
import type {
  CompiledSubscription,
  CompiledUnit,
  IdfVocabulary,
  MatchCandidateInput,
  RoleEquivalencePair,
  RoleTrackTitles,
  TickUnit,
} from '@jobseeker/engine';
import {
  parseSourceKey,
  parseUserId,
  type SourceKey,
  type UserId,
} from '@jobseeker/engine/contracts';
import { assertTransition, type MatchState } from '@jobseeker/engine/match-state';
import { parseSourceKey as sourceKey, parseUserId as userId } from '@jobseeker/engine/contracts';
import {
  postgresQuery,
  storeSettings,
  withPostgresTransaction,
} from './client.ts';
import type { ScoreExplanation } from './repos.ts';

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}: expected a positive safe integer.`);
}
function validDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`Invalid ${name}: expected a valid Date.`);
}

interface DueRow extends QueryResultRow {
  unit_id: string;
  platform: string;
  query_json: unknown;
  cadence_minutes: number;
  next_run_at: Date | string;
  subscribers: Array<{ userId: string; searchName: string }>;
}

export async function dueUnits(now: Date): Promise<readonly TickUnit[]> {
  validDate(now, 'due-unit time');
  const result = await postgresQuery<DueRow>(`select u.unit_id,u.platform,u.query_json,u.cadence_minutes,u.next_run_at,
      jsonb_agg(jsonb_build_object('userId',s.user_id,'searchName',s.search_name) order by s.user_id) subscribers
    from search_units u join unit_subscriptions s on s.unit_id=u.unit_id
      join users usr on usr.user_id=s.user_id and usr.status='approved'
    where u.retired_at is null and u.next_run_at<=$1 and u.platform=any($2::text[])
    group by u.unit_id order by u.next_run_at,u.unit_id`, [now, storeSettings().searchPlatforms]);
  return Object.freeze(result.rows.map((row) => Object.freeze({
    unitId: row.unit_id as TickUnit['unitId'],
    platform: parseSourceKey(row.platform),
    query: row.query_json,
    cadenceMinutes: Number(row.cadence_minutes),
    nextRunAt: new Date(row.next_run_at),
    subscribers: Object.freeze(row.subscribers.map((entry) => Object.freeze({
      userId: parseUserId(entry.userId), searchName: String(entry.searchName),
    }))),
  })));
}

export async function nextUnitDueAt(): Promise<Date | null> {
  const result = await postgresQuery<{ next_run_at: Date | string | null }>(
    'select min(next_run_at) next_run_at from search_units where retired_at is null');
  return result.rows[0]?.next_run_at ? new Date(result.rows[0].next_run_at) : null;
}

export async function recordUnitRun(
  unitId: TickUnit['unitId'], cadenceMinutes: number, foundNovelty: boolean, now: Date,
): Promise<void> {
  positiveInteger(cadenceMinutes, 'cadence'); validDate(now, 'unit run time');
  // Every use of a parameter must deduce one type: an untyped $n both assigned to an integer column and multiplied
  // by an interval literal is rejected with 42P08, which would silently stop every unit from ever advancing.
  await postgresQuery(`update search_units set cadence_minutes=$2::integer,last_run_at=$3::timestamptz,
      last_novelty_at=case when $4::boolean then $3::timestamptz else last_novelty_at end,
      next_run_at=$3::timestamptz+make_interval(mins=>$2::integer),updated_at=$3::timestamptz
    where unit_id=$1 and retired_at is null`, [unitId, cadenceMinutes, now, foundNovelty]);
}

export async function existingCompiledUnits(): Promise<readonly CompiledUnit[]> {
  const result = await postgresQuery<{
    unit_id: string; platform: string; filter_signature: string; canonical_tokens: string[]; query_json: unknown;
  }>('select unit_id,platform,filter_signature,canonical_tokens,query_json from search_units where retired_at is null order by unit_id');
  return Object.freeze(result.rows.map((row) => Object.freeze({
    unitId: row.unit_id as CompiledUnit['unitId'], platform: sourceKey(row.platform),
    filterSignature: row.filter_signature as CompiledUnit['filterSignature'],
    canonicalTokens: Object.freeze(row.canonical_tokens), query: row.query_json,
  })));
}

export async function activeUnitQueries(platform: SourceKey): Promise<readonly unknown[]> {
  const result = await postgresQuery<{ query_json: unknown }>(
    'select query_json from search_units where platform=$1 and retired_at is null order by unit_id', [platform]);
  return Object.freeze(result.rows.map((row) => row.query_json));
}

export async function applyDemand(
  targetUserId: UserId,
  units: readonly CompiledUnit[],
  subscriptions: readonly CompiledSubscription[],
  initialCadence: number,
): Promise<void> {
  positiveInteger(initialCadence, 'initial cadence');
  if (subscriptions.some((subscription) => subscription.userId !== targetUserId)) {
    throw new TypeError('Invalid demand application: subscription belongs to another user.');
  }
  await withPostgresTransaction(async (client) => {
    for (const unit of units) {
      await client.query(`insert into search_units(unit_id,platform,filter_signature,canonical_tokens,query_json,
          cadence_minutes,next_run_at) values($1,$2,$3,$4::jsonb,$5::jsonb,$6,now())
        on conflict(unit_id) do update set query_json=excluded.query_json,retired_at=null,updated_at=now()`, [
        unit.unitId, unit.platform, unit.filterSignature, JSON.stringify(unit.canonicalTokens), JSON.stringify(unit.query), initialCadence,
      ]);
    }
    for (const subscription of subscriptions) {
      await client.query(`insert into unit_subscriptions(unit_id,user_id,search_name,source_search_json)
          values($1,$2,$3,$4::jsonb)
        on conflict(unit_id,user_id) do update set search_name=excluded.search_name,
          source_search_json=excluded.source_search_json,updated_at=now()`, [
        subscription.unitId, targetUserId, subscription.searchName, JSON.stringify(subscription.sourceSearch),
      ]);
    }
    const retained = subscriptions.map((subscription) => subscription.unitId);
    await client.query(`delete from unit_subscriptions where user_id=$1
      and not(unit_id=any($2::text[]))`, [targetUserId, retained]);
    await client.query(`update search_units set retired_at=now(),updated_at=now() where retired_at is null
      and not exists(select 1 from unit_subscriptions s where s.unit_id=search_units.unit_id)`);
  });
}

export async function createMatches(candidates: readonly MatchCandidateInput[], now: Date): Promise<number> {
  validDate(now, 'match time');
  if (candidates.length === 0) return 0;
  return withPostgresTransaction(async (client) => {
    let inserted = 0;
    for (const item of candidates) {
      positiveInteger(item.vacancyId, 'vacancy ID');
      const result = await client.query(`insert into matches(user_id,vacancy_id,state,matched_at,updated_at,
          lexical_score,regex_score,lexical_cosine,title_similarity,skill_coverage,seniority_gap,specificity,lexical_cosine_idf)
        values($1,$2,'matched',$3,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`, [
        item.userId, item.vacancyId, now, item.score, item.regexScore, item.lexicalCosine,
        item.titleSimilarity, item.skillCoverage, item.seniorityGap, item.specificity, item.lexicalCosineIdf,
      ]);
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  });
}

export async function transitionMatch(
  targetUserId: UserId, vacancyId: number, from: MatchState, to: MatchState, now: Date,
): Promise<boolean> {
  assertTransition(from, to); positiveInteger(vacancyId, 'vacancy ID'); validDate(now, 'transition time');
  const result = await postgresQuery(`update matches set state=$4,updated_at=$5,
      delivered_at=case when $4=any(array['alerted','digested','skipped','applying','applied'])
        then coalesce(delivered_at,$5) else delivered_at end
    where user_id=$1 and vacancy_id=$2 and state=$3`, [targetUserId, vacancyId, from, to, now]);
  return (result.rowCount ?? 0) === 1;
}

export async function claimMatches(targetUserId: UserId, vacancyIds: readonly number[]): Promise<readonly number[]> {
  const unique = [...new Set(vacancyIds)];
  if (unique.length !== vacancyIds.length) throw new TypeError('Invalid match claims: duplicate vacancy ID.');
  unique.forEach((id) => positiveInteger(id, 'vacancy ID'));
  if (!unique.length) return Object.freeze([]);
  // The source-state predicate makes concurrent claimers cleanly lose rather than sharing work.
  const result = await postgresQuery<{ vacancy_id: string }>(`update matches set state='queued',queued_at=now(),updated_at=now()
    where user_id=$1 and vacancy_id=any($2::bigint[]) and state='matched' returning vacancy_id`, [targetUserId, unique]);
  return Object.freeze(result.rows.map((row) => Number(row.vacancy_id)).sort((a, b) => a - b));
}

export async function releaseMatchClaims(targetUserId: UserId, vacancyIds: readonly number[]): Promise<number> {
  const unique = [...new Set(vacancyIds)];
  if (unique.length !== vacancyIds.length) throw new TypeError('Invalid released match claims: duplicate vacancy ID.');
  unique.forEach((id) => positiveInteger(id, 'vacancy ID'));
  if (!unique.length) return 0;
  const result = await postgresQuery(`update matches set state='matched',updated_at=now()
    where user_id=$1 and vacancy_id=any($2::bigint[]) and state='queued' and llm_score is null`, [targetUserId, unique]);
  return result.rowCount ?? 0;
}

export interface PendingMatch {
  readonly userId: UserId;
  readonly vacancyId: number;
  readonly source: SourceKey;
  readonly publishedAt: Date;
  readonly matchedAt: Date;
  readonly lexicalScore: number;
  readonly regexScore: number;
  readonly lexicalCosine: number;
  readonly titleSimilarity: number;
  readonly skillCoverage: number;
  readonly seniorityGap: number | null;
  readonly specificity: number | null;
  readonly lexicalCosineIdf: number | null;
  readonly prescoreScore: number | null;
  readonly prescoreModel: string | null;
  readonly prescorePromptVersion: string | null;
  readonly prescoreExploration: boolean;
}

interface PendingRow extends QueryResultRow {
  user_id: string; vacancy_id: string; source: string; published_at: Date | string; matched_at: Date | string;
  lexical_score: number; regex_score: number; lexical_cosine: number; title_similarity: number; skill_coverage: number;
  seniority_gap: number | null; specificity: number | null; lexical_cosine_idf: number | null;
  prescore_score: number | null; prescore_model: string | null; prescore_prompt_version: string | null;
  prescore_exploration: boolean;
}

function pendingOf(row: PendingRow): PendingMatch {
  return Object.freeze({
    userId: userId(row.user_id), vacancyId: Number(row.vacancy_id), source: sourceKey(row.source),
    publishedAt: new Date(row.published_at), matchedAt: new Date(row.matched_at), lexicalScore: row.lexical_score,
    regexScore: row.regex_score, lexicalCosine: row.lexical_cosine, titleSimilarity: row.title_similarity,
    skillCoverage: row.skill_coverage, seniorityGap: row.seniority_gap, specificity: row.specificity,
    lexicalCosineIdf: row.lexical_cosine_idf, prescoreScore: row.prescore_score, prescoreModel: row.prescore_model,
    prescorePromptVersion: row.prescore_prompt_version, prescoreExploration: row.prescore_exploration,
  });
}

const pendingSelect = `select m.*,v.source,v.published_at from matches m join vacancies v on v.id=m.vacancy_id`;

export async function pendingMatchesForScoring(
  targetUserId: UserId, cap: number, model: string | null, promptVersion: string | null, minimumPrescore: number,
  allowExploration: boolean,
): Promise<readonly PendingMatch[]> {
  positiveInteger(cap, 'scoring cap');
  if ((model === null) !== (promptVersion === null)) throw new TypeError('Prescore model and prompt version must both be set or both be null.');
  const result = await postgresQuery<PendingRow>(`${pendingSelect} where m.user_id=$1 and m.state='matched'
    and (m.updated_at=m.matched_at or m.updated_at<=now()-interval '6 hours')
    and (($3::text is null and m.prescore_score is null)
      or (m.prescore_model=$3 and m.prescore_prompt_version=$4 and (m.prescore_score>=$5 or ($6 and m.prescore_exploration))))
    order by coalesce(m.prescore_score,m.lexical_score) desc,m.matched_at,m.vacancy_id limit $2`,
  [targetUserId, cap, model, promptVersion, minimumPrescore, allowExploration]);
  return Object.freeze(result.rows.map(pendingOf));
}

export async function pendingMatchesForPrescoring(
  targetUserId: UserId, cap: number, model: string, promptVersion: string,
): Promise<readonly PendingMatch[]> {
  positiveInteger(cap, 'prescoring cap');
  const result = await postgresQuery<PendingRow>(`${pendingSelect} where m.user_id=$1 and m.state='matched'
    and (m.prescore_model is distinct from $3 or m.prescore_prompt_version is distinct from $4 or m.prescore_score is null)
    order by m.lexical_score desc,m.matched_at,m.vacancy_id limit $2`, [targetUserId, cap, model, promptVersion]);
  return Object.freeze(result.rows.map(pendingOf));
}

export async function savePrescore(
  targetUserId: UserId, vacancyId: number, score: number, model: string, promptVersion: string,
  exploration: boolean,
): Promise<boolean> {
  const result = await postgresQuery(`update matches set prescore_score=$3,prescore_model=$4,prescore_prompt_version=$5,
      prescored_at=now(),prescore_exploration=$6,state='matched',updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state='queued' and llm_score is null`,
  [targetUserId, vacancyId, score, model, promptVersion, exploration]);
  return (result.rowCount ?? 0) === 1;
}

export async function saveScore(
  targetUserId: UserId, vacancyId: number, score: number, primaryTrack: string, summary: string,
  reasons: readonly string[], gaps: readonly string[], hardRejection: boolean, model: string,
  explanation: ScoreExplanation,
): Promise<boolean> {
  const result = await postgresQuery(`update matches set state='scored',llm_score=$3,primary_track=$4,short_summary=$5,
      short_reasons=$6::jsonb,short_gaps=$7::jsonb,hard_rejection=$8,score_model=$9,
      score_explanation=$10::jsonb,score_updated_at=now(),updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state='queued'`, [
    targetUserId, vacancyId, score, primaryTrack, summary, JSON.stringify(reasons), JSON.stringify(gaps),
    hardRejection, model, JSON.stringify(explanation),
  ]);
  return (result.rowCount ?? 0) === 1;
}

export async function savedScoreVacancyIds(targetUserId: UserId, vacancyIds: readonly number[]): Promise<readonly number[]> {
  const unique = [...new Set(vacancyIds)];
  if (unique.length !== vacancyIds.length) throw new TypeError('Invalid saved-score lookup: duplicate vacancy ID.');
  unique.forEach((id) => positiveInteger(id, 'vacancy ID'));
  if (!unique.length) return Object.freeze([]);
  const result = await postgresQuery<{ vacancy_id: string }>(`select vacancy_id from matches
    where user_id=$1 and vacancy_id=any($2::bigint[]) and llm_score is not null order by vacancy_id`, [targetUserId, unique]);
  return Object.freeze(result.rows.map((row) => Number(row.vacancy_id)));
}

export async function expireStaleMatches(maxAgeDays: number, now: Date): Promise<number> {
  positiveInteger(maxAgeDays, 'match maximum age'); validDate(now, 'expiry time');
  const result = await postgresQuery(`update matches m set state='expired',updated_at=$2::timestamptz
    from vacancies v where v.id=m.vacancy_id and m.state='matched' and m.llm_score is null
      and v.published_at<$2::timestamptz-make_interval(days=>$1::integer)`, [maxAgeDays, now]);
  return result.rowCount ?? 0;
}

export type AccountCounter = 'scores' | 'applications' | 'search_profiles';

export async function addSpend(
  targetUserId: UserId, day: string, costUsd: number, counter: AccountCounter,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new TypeError('Invalid account spend input.');
  }
  const column = { scores: 'scores', applications: 'applications', search_profiles: 'search_profiles' }[counter];
  if (!column) throw new TypeError('Invalid account counter.');
  await postgresQuery(`insert into accounts(user_id,day,spent_usd,${column}) values($1,$2,$3,1)
    on conflict(user_id,day) do update set spent_usd=accounts.spent_usd+excluded.spent_usd,
      ${column}=accounts.${column}+1,updated_at=now()`, [targetUserId, day, costUsd]);
}

export async function spentToday(targetUserId: UserId, day: string): Promise<number> {
  const result = await postgresQuery<{ spent_usd: string | number }>(
    'select spent_usd from accounts where user_id=$1 and day=$2', [targetUserId, day]);
  return Number(result.rows[0]?.spent_usd ?? 0);
}

export async function replaceRoleEquivalences(pairs: readonly RoleEquivalencePair[]): Promise<void> {
  await withPostgresTransaction(async (client) => {
    await client.query('delete from role_equivalences');
    for (const pair of pairs) await client.query(
      'insert into role_equivalences(token_a,token_b,support) values($1,$2,$3)',
      [pair.tokenA, pair.tokenB, pair.support]);
  });
}

export async function loadRoleEquivalences(minimumSupport = 1): Promise<readonly RoleEquivalencePair[]> {
  positiveInteger(minimumSupport, 'minimum equivalence support');
  const result = await postgresQuery<RoleEquivalencePair & QueryResultRow>(`select token_a "tokenA",token_b "tokenB",support
    from role_equivalences where support>=$1 order by token_a,token_b`, [minimumSupport]);
  return Object.freeze(result.rows.map((row) => Object.freeze({ tokenA: row.tokenA, tokenB: row.tokenB, support: row.support })));
}

export async function roleTrackTitles(): Promise<readonly RoleTrackTitles[]> {
  const result = await postgresQuery<{ career_profile: unknown }>(`select c.career_profile from cv_documents c
    join users u on u.user_id=c.user_id and u.status='approved' where c.career_profile is not null order by c.user_id`);
  const tracks: RoleTrackTitles[] = [];
  for (const row of result.rows) {
    const root = typeof row.career_profile === 'object' && row.career_profile !== null && !Array.isArray(row.career_profile)
      ? row.career_profile as Record<string, unknown> : null;
    const profile = root && typeof root.profile === 'object' && root.profile !== null && !Array.isArray(root.profile)
      ? root.profile as Record<string, unknown> : root;
    if (!profile || !Array.isArray(profile.tracks)) continue;
    for (const value of profile.tracks) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const variants = (value as Record<string, unknown>).titleVariants;
      if (!Array.isArray(variants) || variants.some((title) => typeof title !== 'string')) continue;
      tracks.push(Object.freeze({ titleVariants: Object.freeze([...variants] as string[]) }));
    }
  }
  return Object.freeze(tracks);
}

export type IdfScope = 'title' | 'body';

export async function replaceIdfVocabulary(scope: IdfScope, vocabulary: IdfVocabulary): Promise<void> {
  await withPostgresTransaction(async (client) => {
    await client.query(`insert into idf_corpora(scope,documents,unknown_idf) values($1,$2,$3)
      on conflict(scope) do update set documents=excluded.documents,unknown_idf=excluded.unknown_idf,rebuilt_at=now()`,
    [scope, vocabulary.documents, vocabulary.unknownIdf]);
    await client.query('delete from idf_vocabulary where scope=$1', [scope]);
    for (let offset = 0; offset < vocabulary.entries.length; offset += 1_000) {
      const chunk = vocabulary.entries.slice(offset, offset + 1_000);
      await client.query(`insert into idf_vocabulary(scope,token,idf)
        select $1,entry.token,entry.idf from unnest($2::text[],$3::double precision[]) entry(token,idf)`, [
        scope, chunk.map((entry) => entry.token), chunk.map((entry) => entry.idf),
      ]);
    }
  });
}

export async function loadIdfVocabulary(scope: IdfScope): Promise<IdfVocabulary | null> {
  const corpus = await postgresQuery<{ documents: string; unknown_idf: number }>(
    'select documents,unknown_idf from idf_corpora where scope=$1', [scope]);
  if (!corpus.rows[0]) return null;
  const entries = await postgresQuery<{ token: string; idf: number }>(
    'select token,idf from idf_vocabulary where scope=$1 order by token', [scope]);
  return Object.freeze({
    documents: Number(corpus.rows[0].documents), unknownIdf: corpus.rows[0].unknown_idf,
    entries: Object.freeze(entries.rows.map((entry) => Object.freeze(entry))),
  });
}

/** Replaces one complete derived matching generation so persisted readers never observe mixed old/new scopes. */
export async function replaceMatchingVocabularies(input: {
  readonly equivalences: readonly RoleEquivalencePair[];
  readonly title: IdfVocabulary;
  readonly body: IdfVocabulary;
}): Promise<void> {
  await withPostgresTransaction(async (client) => {
    await client.query('delete from role_equivalences');
    for (const pair of input.equivalences) await client.query(
      'insert into role_equivalences(token_a,token_b,support) values($1,$2,$3)',
      [pair.tokenA, pair.tokenB, pair.support]);
    for (const [scope, vocabulary] of [['title', input.title], ['body', input.body]] as const) {
      await client.query(`insert into idf_corpora(scope,documents,unknown_idf) values($1,$2,$3)
        on conflict(scope) do update set documents=excluded.documents,unknown_idf=excluded.unknown_idf,rebuilt_at=now()`,
      [scope, vocabulary.documents, vocabulary.unknownIdf]);
      await client.query('delete from idf_vocabulary where scope=$1', [scope]);
      for (let offset = 0; offset < vocabulary.entries.length; offset += 1_000) {
        const chunk = vocabulary.entries.slice(offset, offset + 1_000);
        await client.query(`insert into idf_vocabulary(scope,token,idf)
          select $1,entry.token,entry.idf from unnest($2::text[],$3::double precision[]) entry(token,idf)`, [
          scope, chunk.map((entry) => entry.token), chunk.map((entry) => entry.idf),
        ]);
      }
    }
  });
}

export async function recentNormalizedVacancyIds(
  afterId: number, limit: number, maximumAgeDays: number,
): Promise<readonly number[]> {
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new RangeError('Invalid recent-vacancy cursor.');
  positiveInteger(limit, 'recent-vacancy batch limit'); positiveInteger(maximumAgeDays, 'recent-vacancy maximum age');
  const result = await postgresQuery<{ id: string }>(`select id from vacancies where id>$1
    and lifecycle_status='normalized' and published_at>=now()-make_interval(days=>$3::integer) order by id limit $2`,
  [afterId, limit, maximumAgeDays]);
  return Object.freeze(result.rows.map((row) => Number(row.id)));
}

export async function vacancyTextBatch(
  afterId: number, limit: number,
): Promise<readonly { readonly id: number; readonly title: string; readonly body: string }[]> {
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new RangeError('Invalid corpus cursor.');
  positiveInteger(limit, 'corpus batch limit');
  const result = await postgresQuery<{ id: string; name: string; description: string; key_skills_json: string[] }>(
    `select id,name,description,key_skills_json from vacancies where id>$1 and lifecycle_status='normalized'
      order by id limit $2`, [afterId, limit]);
  return Object.freeze(result.rows.map((row) => Object.freeze({
    id: Number(row.id), title: row.name, body: `${row.description}\n${row.key_skills_json.join(' ')}`,
  })));
}
