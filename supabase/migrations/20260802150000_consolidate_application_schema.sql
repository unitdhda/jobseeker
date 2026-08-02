-- Consolidate one-to-one state into user_vacancies and remove transition-only tables/columns.

alter table public.user_vacancies
  add column if not exists score integer check (score between 0 and 100),
  add column if not exists application_status text check (application_status in ('generating','ready','failed')),
  add column if not exists application_error text,
  add column if not exists application_requested_at text,
  add column if not exists application_updated_at text;

insert into public.user_vacancies(user_id,vacancy_id,decision,first_relevant_at,score_updated_at,updated_at)
select s.user_id,s.vacancy_id,'new',v.first_seen_at,v.updated_at,v.updated_at
from public.scores s join public.vacancies v on v.id=s.vacancy_id
on conflict(user_id,vacancy_id) do nothing;

update public.user_vacancies uv set score=s.score
from public.scores s where s.user_id=uv.user_id and s.vacancy_id=uv.vacancy_id;

insert into public.user_vacancies(user_id,vacancy_id,decision,first_relevant_at,updated_at)
select a.user_id,a.vacancy_id,case when a.status='generating' then 'applying' else 'new' end,v.first_seen_at,a.updated_at
from public.applications a join public.vacancies v on v.id=a.vacancy_id
on conflict(user_id,vacancy_id) do nothing;

update public.user_vacancies uv set
  application_status=a.status,
  application_error=a.error,
  application_requested_at=a.requested_at,
  application_updated_at=a.updated_at
from public.applications a where a.user_id=uv.user_id and a.vacancy_id=uv.vacancy_id;

do $$
declare constraint_row record;
begin
  for constraint_row in
    select conname from pg_constraint
    where conrelid='public.score_alert_details'::regclass and confrelid='public.scores'::regclass
  loop
    execute format('alter table public.score_alert_details drop constraint %I', constraint_row.conname);
  end loop;
end $$;

alter table public.score_alert_details
  add constraint score_alert_details_user_vacancy_fkey
  foreign key(user_id,vacancy_id) references public.user_vacancies(user_id,vacancy_id) on delete cascade;

drop table public.scores;
drop table public.applications;
drop table if exists public.global_scheduler_settings;
drop table if exists public.pending_deliveries;
drop table if exists public.app_migrations;

alter table public.vacancies drop column if exists hh_id;
alter table public.vacancies drop column if exists decision;

create table if not exists public.coordination_leases (
  resource_key text primary key,
  lease_owner text not null,
  lease_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
insert into public.coordination_leases(resource_key,lease_owner,lease_expires_at,updated_at)
select 'telegram-user:'||user_id,update_id::text,lease_expires_at,updated_at
from public.telegram_user_update_leases
on conflict(resource_key) do update set lease_owner=excluded.lease_owner,
  lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at;
drop table public.telegram_user_update_leases;
create index if not exists coordination_leases_expiry_idx on public.coordination_leases(lease_expires_at);
revoke all on public.coordination_leases from anon, authenticated;

-- PostgreSQL should store structured values as JSONB rather than encoded JSON text.
drop index if exists public.vacancies_search_idx;
alter table public.vacancies drop column if exists search_vector;
alter table public.cv_templates alter column document_json type jsonb using document_json::jsonb;
alter table public.search_profiles alter column profile_json type jsonb using profile_json::jsonb;
alter table public.vacancies alter column key_skills_json type jsonb using key_skills_json::jsonb;
alter table public.score_alert_details alter column reasons_json type jsonb using reasons_json::jsonb;
alter table public.score_alert_details alter column gaps_json type jsonb using gaps_json::jsonb;
alter table public.prefilter_scores alter column reasons_json type jsonb using reasons_json::jsonb;
alter table public.vacancy_candidates alter column payload_json type jsonb using payload_json::jsonb;
alter table public.vacancy_candidates alter column filter_reasons_json type jsonb
  using case when filter_reasons_json is null then null else filter_reasons_json::jsonb end;
alter table public.candidate_prefilter_scores alter column reasons_json type jsonb using reasons_json::jsonb;

alter table public.vacancies add column search_vector tsvector generated always as (
  to_tsvector('simple',coalesce(name,'')||' '||coalesce(employer,'')||' '||
    coalesce(description,'')||' '||coalesce(key_skills_json::text,''))
) stored;
create index vacancies_search_idx on public.vacancies using gin(search_vector);

-- Replace transitional ISO text timestamps with native timestamps.
alter table public.telegram_users
  alter column requested_at type timestamptz using nullif(requested_at,'')::timestamptz,
  alter column approved_at type timestamptz using nullif(approved_at,'')::timestamptz,
  alter column updated_at type timestamptz using updated_at::timestamptz;
alter table public.cv_templates alter column updated_at type timestamptz using updated_at::timestamptz;
alter table public.search_profiles alter column updated_at type timestamptz using updated_at::timestamptz;
alter table public.user_delivery_windows
  alter column last_digest_at type timestamptz using nullif(last_digest_at,'')::timestamptz,
  alter column updated_at type timestamptz using updated_at::timestamptz;
alter table public.vacancies
  alter column published_at type timestamptz using published_at::timestamptz,
  alter column first_seen_at type timestamptz using first_seen_at::timestamptz,
  alter column updated_at type timestamptz using updated_at::timestamptz;
alter table public.user_vacancies
  alter column first_relevant_at type timestamptz using first_relevant_at::timestamptz,
  alter column score_updated_at type timestamptz using nullif(score_updated_at,'')::timestamptz,
  alter column updated_at type timestamptz using updated_at::timestamptz,
  alter column application_requested_at type timestamptz using nullif(application_requested_at,'')::timestamptz,
  alter column application_updated_at type timestamptz using nullif(application_updated_at,'')::timestamptz;
alter table public.prefilter_scores alter column scored_at type timestamptz using scored_at::timestamptz;
alter table public.embedding_cache alter column created_at type timestamptz using created_at::timestamptz;
alter table public.vacancy_candidates
  alter column published_at type timestamptz using coalesce(nullif(published_at,''),first_seen_at)::timestamptz,
  alter column next_retry_at type timestamptz using nullif(next_retry_at,'')::timestamptz,
  alter column first_seen_at type timestamptz using first_seen_at::timestamptz,
  alter column last_seen_at type timestamptz using last_seen_at::timestamptz,
  alter column last_checked_at type timestamptz using nullif(last_checked_at,'')::timestamptz;
alter table public.candidate_discoveries
  alter column first_seen_at type timestamptz using first_seen_at::timestamptz,
  alter column last_seen_at type timestamptz using last_seen_at::timestamptz;
alter table public.candidate_prefilter_scores alter column scored_at type timestamptz using scored_at::timestamptz;
alter table public.usage_events alter column occurred_at type timestamptz using occurred_at::timestamptz;

create index if not exists user_vacancies_score_idx on public.user_vacancies(user_id,score desc) where score is not null;
