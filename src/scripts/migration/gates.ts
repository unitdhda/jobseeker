/**
 * The invariant gates that must all pass before a cutover is even discussed. Every gate reads both schemas and
 * returns violations, not booleans, so a failure names the rows that would have been hurt.
 */
import type { PoolClient } from 'pg';

export interface GateResult { gate: string; ok: boolean; detail: string }

async function count(client: PoolClient, sql: string): Promise<number> {
  return Number((await client.query(sql)).rows[0]?.n ?? -1);
}

/** Gate A — conservation: nothing countable goes missing. */
export async function gateConservation(client: PoolClient): Promise<GateResult[]> {
  const pairs: [name: string, legacy: string, current: string][] = [
    ['users', 'select count(*) n from legacy.users', 'select count(*) n from public.users'],
    ['cv documents', 'select count(*) n from legacy.profiles', 'select count(*) n from public.cv_documents'],
    ['cv hashes', 'select count(distinct cv_sha256) n from legacy.profiles',
      'select count(distinct cv_sha256) n from public.cv_documents'],
    ['vacancies', 'select count(*) n from legacy.vacancies', 'select count(*) n from public.vacancies'],
    ['scores', `select count(*) n from legacy.user_vacancies where score is not null and vacancy_id is not null`,
      'select count(*) n from public.matches where llm_score is not null'],
    ['applications', `select count(*) n from legacy.user_vacancies where application_status is not null and vacancy_id is not null`,
      'select count(*) n from public.matches where application_status is not null'],
    ['usage events', 'select count(*) n from legacy.usage_events', 'select count(*) n from public.usage_events'],
  ];
  const results: GateResult[] = [];
  for (const [name, legacySql, currentSql] of pairs) {
    const [before, after] = [await count(client, legacySql), await count(client, currentSql)];
    results.push({ gate: `A:${name}`, ok: before === after, detail: `legacy=${before} migrated=${after}` });
  }
  const scoreDrift = await count(client, `select count(*) n from legacy.user_vacancies uv
    join public.matches m on m.user_id = uv.user_id and m.vacancy_id = uv.vacancy_id
    where uv.score is distinct from m.llm_score`);
  results.push({ gate: 'A:score values', ok: scoreDrift === 0, detail: `pairs with drifted scores: ${scoreDrift}` });
  return results;
}

/** Gate B — the no-re-alert property: delivery memory survives perfectly. */
export async function gateDeliveryMemory(client: PoolClient): Promise<GateResult[]> {
  const missing = await count(client, `select count(*) n from legacy.user_vacancies uv
    where uv.decision in ('alerted','digested','skipped','applying','applied') and uv.vacancy_id is not null
      and not exists (select 1 from public.matches m
        where m.user_id = uv.user_id and m.vacancy_id = uv.vacancy_id and m.state = uv.decision)`);
  const orphaned = await count(client, `select count(*) n from legacy.user_vacancies uv
    where uv.decision in ('alerted','digested','skipped','applying','applied') and uv.vacancy_id is null`);
  return [
    { gate: 'B:delivered pairs preserved', ok: missing === 0, detail: `delivered pairs missing or state-drifted: ${missing}` },
    { gate: 'B:no unmappable deliveries', ok: orphaned === 0, detail: `delivered rows without vacancy_id: ${orphaned}` },
  ];
}

/** Gate C — dedup memory: every listing the old world knew is known to the new one. */
export async function gateDedupMemory(client: PoolClient): Promise<GateResult[]> {
  const missing = await count(client, `select count(*) n from (
    select source, source_id from legacy.vacancies except select source, source_id from public.vacancies) gap`);
  return [{ gate: 'C:store identity', ok: missing === 0, detail: `listings missing from the store: ${missing}` }];
}

/** Gate D — demand equivalence: every user's platform demand compiled into at least one subscription. */
export async function gateDemand(client: PoolClient): Promise<GateResult[]> {
  const uncovered = await client.query<{ user_id: string; platform: string }>(`
    with demand as (
      select p.user_id, plat.key as platform
      from legacy.profiles p, jsonb_each(p.search_profiles) plat
      where plat.key not like '\\_\\_%' and jsonb_array_length(coalesce(plat.value->'searches','[]'::jsonb)) > 0
    )
    select d.user_id, d.platform from demand d
    where not exists (select 1 from public.unit_subscriptions s
      join public.search_units u on u.unit_id = s.unit_id
      where s.user_id = d.user_id and u.platform = d.platform)`);
  const rawSearches = await count(client, `select coalesce(sum(jsonb_array_length(coalesce(plat.value->'searches','[]'::jsonb))),0) n
    from legacy.profiles p, jsonb_each(p.search_profiles) plat where plat.key not like '\\_\\_%'`);
  const units = await count(client, 'select count(*) n from public.search_units');
  return [
    { gate: 'D:coverage', ok: uncovered.rows.length === 0,
      detail: uncovered.rows.length ? `uncovered: ${uncovered.rows.map((row) => `${row.user_id}/${row.platform}`).join(', ')}`
        : 'every user/platform demand has a subscription' },
    { gate: 'D:folding', ok: units > 0 && units <= rawSearches, detail: `raw searches=${rawSearches} units=${units}` },
  ];
}

/** Gate E — idempotence: the caller re-runs extract and passes the second run's counts here. */
export function gateIdempotence(secondRun: readonly { table: string; copied: number }[]): GateResult[] {
  const dirty = secondRun.filter((entry) => entry.copied !== 0);
  return [{ gate: 'E:idempotence', ok: dirty.length === 0,
    detail: dirty.length ? dirty.map((entry) => `${entry.table}+${entry.copied}`).join(', ') : 'second run copied nothing' }];
}
