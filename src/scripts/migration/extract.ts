/**
 * Extracts everything worth keeping from the legacy schema into the engine schema. Idempotent: every statement
 * upserts on its primary key, so a failed run is re-runnable and Gate E can assert the second pass changes nothing.
 *
 * Deliberately dropped, per the approved plan: prefilter provenance columns, candidate-lifecycle bookkeeping, and
 * user_vacancies rows that never became a normalized vacancy or carry no delivery/score/application memory.
 */
import type { PoolClient } from 'pg';
import { compileDemand, type DemandInput } from '@jobseeker/engine';

export interface ExtractCounts { table: string; copied: number }

const copies: [table: string, sql: string][] = [
  ['users', `insert into public.users select * from legacy.users on conflict (user_id) do nothing`],
  ['cv_documents', `insert into public.cv_documents (user_id, cv_sha256, cv_text, document_json, source_format,
      original_filename, media_type, parser_name, parser_version, search_profiles, updated_at)
    select user_id, cv_sha256, cv_text, document_json, source_format, original_filename, media_type,
      parser_name, parser_version, search_profiles, updated_at from legacy.profiles
    on conflict (user_id) do nothing`],
  ['vacancies', `insert into public.vacancies (id, source, source_id, apply_id, name, employer, area, salary_from,
      salary_to, salary_currency, salary_gross, experience, employment, schedule, work_format, description,
      key_skills_json, url, published_at, source_query, content_hash, canonical_fingerprint, first_seen_at,
      updated_at, listing_search_name, listing_title, listing_summary, listing_payload, listing_hash,
      lifecycle_status, normalized_vacancy_id, normalization_attempts, normalization_error, normalization_retry_at,
      last_seen_at, last_checked_at)
    select id, source, source_id, apply_id, name, employer, area, salary_from, salary_to, salary_currency,
      salary_gross, experience, employment, schedule, work_format, description, key_skills_json, url, published_at,
      source_query, content_hash, canonical_fingerprint, first_seen_at, updated_at, listing_search_name,
      listing_title, listing_summary, listing_payload, listing_hash, lifecycle_status, normalized_vacancy_id,
      normalization_attempts, normalization_error, normalization_retry_at, last_seen_at, last_checked_at
    from legacy.vacancies on conflict (id) do nothing`],
  ['matches', `insert into public.matches (user_id, vacancy_id, state, lexical_score, llm_score, score_updated_at,
      alert_primary_track, alert_summary, alert_reasons, alert_gaps, application_status, application_error,
      application_requested_at, application_updated_at, matched_at, updated_at)
    select user_id, vacancy_id,
      case decision when 'new' then (case when score is not null then 'scored' else 'matched' end)
        else decision end,
      prefilter_score, score, score_updated_at,
      alert_primary_track, alert_summary, alert_reasons, alert_gaps, application_status, application_error,
      application_requested_at, application_updated_at, first_relevant_at, updated_at
    from legacy.user_vacancies
    where vacancy_id is not null
      and (decision <> 'new' or score is not null or application_status is not null or prefilter_filtered = 0)
    on conflict (user_id, vacancy_id) do nothing`],
  ['usage_events', `insert into public.usage_events (id, user_id, kind, occurred_at, agent, model, input_tokens,
      output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd)
    select id, user_id, kind, occurred_at, agent, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, total_tokens, cost_usd from legacy.usage_events on conflict (id) do nothing`],
  ['accounts', `insert into public.accounts (user_id, day, llm_cost_usd, scores, applications, search_profiles)
    select user_id, (occurred_at at time zone 'UTC')::date, sum(cost_usd),
      count(*) filter (where kind = 'score'), count(*) filter (where kind = 'application'),
      count(*) filter (where kind = 'search-profile')
    from legacy.usage_events group by 1, 2 on conflict (user_id, day) do nothing`],
  ['user_state', `insert into public.user_state select * from legacy.user_state on conflict (user_id, kind) do nothing`],
  ['telegram_updates', `insert into public.telegram_updates select * from legacy.telegram_updates
    on conflict (update_id) do nothing`],
];

/** Sequences must resume above every carried id, or the first new vacancy collides with a migrated one. */
const sequenceFixes = [
  `select setval(pg_get_serial_sequence('public.vacancies', 'id'), greatest((select coalesce(max(id), 1) from public.vacancies), 1))`,
  `select setval(pg_get_serial_sequence('public.usage_events', 'id'), greatest((select coalesce(max(id), 1) from public.usage_events), 1))`,
];

export async function extract(client: PoolClient, similarityThreshold: number,
  initialCadenceMinutes: number): Promise<ExtractCounts[]> {
  const counts: ExtractCounts[] = [];
  for (const [table, sql] of copies) {
    const result = await client.query(sql);
    counts.push({ table, copied: result.rowCount ?? 0 });
  }
  for (const fix of sequenceFixes) await client.query(fix);

  // Demand compilation: stored search profiles become units and subscriptions through the engine's canonicalizer —
  // the same code the runtime uses, so the migration cannot disagree with the scheduler about identity.
  const { rows } = await client.query<{ user_id: string; search_profiles: Record<string, unknown> }>(
    `select user_id, search_profiles from legacy.profiles`);
  const demands: DemandInput[] = [];
  for (const row of rows) {
    for (const [platform, profile] of Object.entries(row.search_profiles ?? {})) {
      if (platform.startsWith('__')) continue; // career-profile pseudo-platform is not a search demand
      const searches = (profile as { searches?: unknown[] })?.searches ?? [];
      if (Array.isArray(searches) && searches.length) demands.push({ userId: row.user_id, platform, searches });
    }
  }
  const compiled = compileDemand(demands, similarityThreshold);
  let units = 0;
  for (const unit of compiled.units) {
    const result = await client.query(`insert into public.search_units (unit_id, platform, filter_signature,
        canonical_tokens, query, cadence_minutes, next_run_at)
      values ($1, $2, $3, $4, $5::jsonb, $6, now()) on conflict (unit_id) do nothing`,
      [unit.unitId, unit.platform, unit.filterSignature, unit.canonicalTokens, JSON.stringify(unit.query),
        initialCadenceMinutes]);
    units += result.rowCount ?? 0;
  }
  counts.push({ table: 'search_units', copied: units });
  let subscriptions = 0;
  for (const subscription of compiled.subscriptions) {
    const result = await client.query(`insert into public.unit_subscriptions (unit_id, user_id, search_name, source_search)
      values ($1, $2, $3, $4::jsonb) on conflict (unit_id, user_id) do nothing`,
      [subscription.unitId, subscription.userId, subscription.searchName || 'search',
        JSON.stringify(subscription.sourceSearch)]);
    subscriptions += result.rowCount ?? 0;
  }
  counts.push({ table: 'unit_subscriptions', copied: subscriptions });
  return counts;
}
