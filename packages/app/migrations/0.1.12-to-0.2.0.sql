\set ON_ERROR_STOP on

-- Blue-green migration for a logical clone of the 0.1.12 production database.
-- The original public schema is retained intact as legacy_0_1_12. Never run this
-- against the active production database; cut over by changing DATABASE_URL only
-- after clone verification succeeds.
begin;
set local lock_timeout = '30s';
set local statement_timeout = '15min';

-- Refuse an unknown source shape or a repeated migration.
do $migration_preconditions$
declare
  actual text[];
  expected constant text[] := array[
    'accounts','calibrations','cv_documents','idf_corpora','idf_vocabulary','matches',
    'pending_cv_imports','role_equivalences','search_units','telegram_updates',
    'unit_subscriptions','usage_events','user_state','users','vacancies'
  ];
begin
  if exists(select 1 from pg_namespace where nspname='legacy_0_1_12') then
    raise exception 'legacy_0_1_12 already exists';
  end if;
  select array_agg(table_name order by table_name) into actual
    from information_schema.tables where table_schema='public' and table_type='BASE TABLE';
  if actual is distinct from expected then
    raise exception 'unexpected 0.1.12 public table inventory';
  end if;
  if exists(select 1 from public.users where is_owner not in (0,1)) then
    raise exception 'users.is_owner contains values outside 0/1';
  end if;
  if exists(select 1 from public.vacancies where salary_gross is not null and salary_gross not in (0,1)) then
    raise exception 'vacancies.salary_gross contains values outside 0/1';
  end if;
  if exists(select 1 from public.vacancies where salary_from is not null and salary_to is not null and salary_from>salary_to) then
    raise exception 'vacancy salary lower bound exceeds upper bound';
  end if;
  if exists(select 1 from public.usage_events where input_tokens>2147483647 or output_tokens>2147483647 or total_tokens>2147483647) then
    raise exception 'usage token count cannot fit rewrite integer columns';
  end if;
end
$migration_preconditions$;

alter schema public rename to legacy_0_1_12;
create schema public authorization current_user;
comment on schema public is 'standard public schema';
grant usage on schema public to public;
set local search_path = public, pg_catalog;

-- This psql include executes inside the surrounding transaction.
\ir ../schema.sql

insert into public.users(
  user_id,username,first_name,last_name,status,is_owner,locale,locale_selected,
  delivery_settings,digest_snapshot,last_digest_at,access_requested_at,
  status_changed_at,created_at,updated_at
)
select
  user_id,username,display_name,null,status,(is_owner=1),locale,(locale is not null),
  jsonb_build_object(
    'enabled', digest_minutes is not null,
    'digestHourUtc', greatest(0,least(23,coalesce(digest_minutes,540)/60)),
    'timezone', coalesce(nullif(delivery_timezone,''),'Europe/Moscow')
  ),
  '{}'::bigint[],last_digest_at,requested_at,
  coalesce(approved_at,requested_at,updated_at),
  coalesce(requested_at,approved_at,updated_at),updated_at
from legacy_0_1_12.users;

insert into public.cv_documents(
  user_id,cv_sha256,cv_text,document_json,source_format,original_filename,
  media_type,parser_name,parser_version,search_profiles,career_profile,created_at,updated_at
)
select
  document.user_id,document.cv_sha256,document.cv_text,document.document_json,document.source_format,document.original_filename,
  document.media_type,document.parser_name,document.parser_version,
  coalesce((select jsonb_object_agg(profile.key,jsonb_build_object(
      'cvHash',document.cv_sha256,'templateVersion',1,'profile',profile.value))
    from jsonb_each(document.search_profiles-'__career-profile-v1') profile),'{}'::jsonb),
  case when jsonb_typeof(document.search_profiles->'__career-profile-v1')='object'
          and jsonb_typeof(document.search_profiles->'__career-profile-v1'->'profile')='object'
    then jsonb_build_object('cvHash',document.cv_sha256,'profile',document.search_profiles->'__career-profile-v1'->'profile')
    else null end,
  document.updated_at,document.updated_at
from legacy_0_1_12.cv_documents document;

insert into public.pending_cv_imports(
  user_id,cv_sha256,cv_text,document_json,source_format,original_filename,
  media_type,parser_name,parser_version,staged_at,expires_at
)
select
  user_id,cv_sha256,extracted_json->>'text',extracted_json->'document',
  extracted_json->>'sourceFormat',original_filename,extracted_json->>'mediaType',
  extracted_json->>'parserName',extracted_json->>'parserVersion',created_at,expires_at
from legacy_0_1_12.pending_cv_imports;

insert into public.vacancies(
  id,source,source_id,apply_id,lifecycle_status,url,published_at,first_seen_at,last_seen_at,
  updated_at,last_checked_at,next_normalization_at,normalization_attempts,normalization_error,
  listing_search_name,listing_title,listing_summary,listing_payload,listing_hash,
  normalized_vacancy_id,canonical_fingerprint,name,employer,area,salary_json,experience_json,
  employment,schedule,work_format,description,key_skills_json,source_query,content_hash
) overriding system value
select
  id,source,source_id,apply_id,lifecycle_status,url,published_at,first_seen_at,
  coalesce(last_seen_at,updated_at,first_seen_at),updated_at,last_checked_at,
  coalesce(normalization_retry_at,updated_at,now()),normalization_attempts,normalization_error,
  listing_search_name,listing_title,listing_summary,listing_payload,listing_hash,
  nullif(normalized_vacancy_id,id),canonical_fingerprint,name,employer,area,
  case when (salary_from is not null or salary_to is not null)
      and salary_currency ~ '^[A-Z]{3}$'
    then jsonb_build_object('from',salary_from,'to',salary_to,'currency',salary_currency,
      'gross',case when salary_gross is null then null else salary_gross=1 end,'period','month')
    else null end,
  case
    when experience is null or btrim(experience)='' then jsonb_build_object('kind','unspecified')
    when lower(experience) in ('без опыта','нет опыта','не требуется') then
      jsonb_build_object('kind','range','minimumYears',0,'maximumYears',0)
    when experience ~ '^([0-9]+)[–-]([0-9]+)[[:space:]]*(год|года|лет)?$' then
      jsonb_build_object('kind','range',
        'minimumYears',(regexp_match(experience,'^([0-9]+)[–-]([0-9]+)'))[1]::int,
        'maximumYears',(regexp_match(experience,'^([0-9]+)[–-]([0-9]+)'))[2]::int)
    when experience ~* '^(от[[:space:]]+)?([0-9]+)[[:space:]]*(год|года|лет)$' then
      jsonb_build_object('kind','range',
        'minimumYears',(regexp_match(lower(experience),'^(?:от[[:space:]]+)?([0-9]+)'))[1]::int,
        'maximumYears',null)
    when experience ~* '^более[[:space:]]+([0-9]+)[[:space:]]*(год|года|лет)$' then
      jsonb_build_object('kind','range',
        'minimumYears',(regexp_match(lower(experience),'^более[[:space:]]+([0-9]+)'))[1]::int,
        'maximumYears',null)
    else jsonb_build_object('kind','other','label',experience)
  end,
  case
    when employment is null or btrim(employment)='' then 'unspecified'
    when lower(employment) ~ 'стажиров' then 'internship'
    when lower(employment) ~ 'частич|part[_ -]?time|подработ' then 'part-time'
    when lower(employment) ~ 'проект|разовое|contract' then 'contract'
    when lower(employment) ~ 'временн|temporary' then 'temporary'
    when lower(employment) ~ 'волонт|volunteer' then 'volunteer'
    when lower(employment) ~ 'полн|full[_ -]?time|fulltime|permanent' then 'full-time'
    else 'other' end,
  case
    when schedule is null or btrim(schedule)='' then 'unspecified'
    when lower(schedule) in ('standard','стандартный')
      or lower(schedule) ~ '5/2|полный рабочий день' then 'standard'
    when lower(schedule) ~ 'гибк|свобод|flexible|ненормирован' then 'flexible'
    when lower(schedule) ~ 'вахт|rotat' then 'rotational'
    when lower(schedule) ~ 'смен|[1-6]/[1-6]' then 'shift'
    else 'other' end,
  case
    when work_format is null or btrim(work_format)='' then 'unspecified'
    when lower(work_format) ~ 'гибрид|hybrid' then 'hybrid'
    when lower(work_format) ~ 'удал|remote' then 'remote'
    when lower(work_format) ~ 'разъезд|производств|field' then 'field'
    when lower(work_format) ~ 'офис|месте работодателя|on.?site' then 'on-site'
    else 'other' end,
  description,key_skills_json,source_query,content_hash
from legacy_0_1_12.vacancies;

insert into public.search_units(
  unit_id,platform,filter_signature,canonical_tokens,query_json,cadence_minutes,
  next_run_at,last_run_at,last_novelty_at,retired_at,created_at,updated_at
)
select unit_id,platform,filter_signature,to_jsonb(canonical_tokens),query,cadence_minutes,
  next_run_at,last_run_at,last_novelty_at,retired_at,created_at,coalesce(last_run_at,created_at)
from legacy_0_1_12.search_units;

insert into public.unit_subscriptions(unit_id,user_id,search_name,source_search_json,created_at,updated_at)
select unit_id,user_id,search_name,source_search,created_at,created_at
from legacy_0_1_12.unit_subscriptions;

insert into public.matches(
  user_id,vacancy_id,state,matched_at,updated_at,queued_at,score_updated_at,delivered_at,
  lexical_score,regex_score,lexical_cosine,title_similarity,skill_coverage,seniority_gap,
  specificity,lexical_cosine_idf,prescore_score,prescore_model,prescore_prompt_version,
  prescored_at,prescore_exploration,llm_score,score_model,score_explanation,primary_track,
  short_summary,short_reasons,short_gaps,hard_rejection,application_status,application_error,
  application_started_at,application_ready_at,application_delivered_at,application_artifacts
)
select
  user_id,vacancy_id,state,matched_at,updated_at,
  case when state='queued' then updated_at else null end,score_updated_at,
  case when state in ('alerted','digested','skipped','applying','applied')
    then coalesce(application_updated_at,application_requested_at,score_updated_at,updated_at) else null end,
  coalesce(lexical_score,0)::double precision,
  coalesce(lexical_regex_score,0)::double precision,
  coalesce(lexical_cosine,0),coalesce(lexical_title_similarity,0),coalesce(lexical_skill_coverage,0),
  lexical_seniority_gap,lexical_specificity,lexical_cosine_idf,prescore_score::double precision,
  prescore_model,prescore_prompt_version::text,prescore_updated_at,prescore_exploration,
  llm_score::double precision,score_model,score_explanation,alert_primary_track,alert_summary,
  alert_reasons,alert_gaps,false,
  case when state='applied' then null else application_status end,application_error,
  application_requested_at,
  case when application_status='ready' then application_updated_at else null end,
  case when state='applied' then application_updated_at else null end,
  application_artifacts
from legacy_0_1_12.matches;

insert into public.idf_corpora(scope,documents,unknown_idf,rebuilt_at)
select scope,documents,unknown_idf,updated_at from legacy_0_1_12.idf_corpora;
insert into public.idf_vocabulary(scope,token,idf)
select scope,token,idf from legacy_0_1_12.idf_vocabulary;
insert into public.role_equivalences(token_a,token_b,support,rebuilt_at)
select token_a,token_b,support,updated_at from legacy_0_1_12.role_equivalences;

insert into public.usage_events(
  id,user_id,kind,agent,model,input_tokens,output_tokens,total_tokens,cost_usd,occurred_at
) overriding system value
select id,user_id,kind,agent,model,input_tokens::integer,output_tokens::integer,
  total_tokens::integer,cost_usd,occurred_at
from legacy_0_1_12.usage_events;

insert into public.accounts(user_id,day,spent_usd,scores,applications,search_profiles,updated_at)
select user_id,day,llm_cost_usd,scores,applications,search_profiles,updated_at
from legacy_0_1_12.accounts;

insert into public.user_state(user_id,kind,state,token,expires_at,updated_at)
select user_id,kind,state,coalesce(state->>'token',state->>'_claimToken'),expires_at,updated_at
from legacy_0_1_12.user_state;

insert into public.telegram_updates(
  update_id,state,attempts,lease_expires_at,error_class,received_at,updated_at,completed_at
)
select update_id,state,attempts,lease_expires_at,
  case when last_error is null then null else 'legacy-error' end,
  received_at,coalesce(completed_at,received_at),completed_at
from legacy_0_1_12.telegram_updates;

select setval(pg_get_serial_sequence('public.vacancies','id'),
  greatest(coalesce((select max(id) from public.vacancies),0),1),
  exists(select 1 from public.vacancies));
select setval(pg_get_serial_sequence('public.usage_events','id'),
  greatest(coalesce((select max(id) from public.usage_events),0),1),
  exists(select 1 from public.usage_events));

-- Transactional postconditions: no silent row loss, no broken delivered wall,
-- and no legacy self-reference leaking into the rewrite duplicate relation.
do $migration_postconditions$
declare
  table_name text;
  old_count bigint;
  new_count bigint;
begin
  foreach table_name in array array[
    'users','cv_documents','pending_cv_imports','vacancies','search_units','unit_subscriptions',
    'matches','idf_corpora','idf_vocabulary','role_equivalences','usage_events','accounts',
    'user_state','telegram_updates'
  ] loop
    execute format('select count(*) from legacy_0_1_12.%I',table_name) into old_count;
    execute format('select count(*) from public.%I',table_name) into new_count;
    if old_count<>new_count then
      raise exception 'row count drift for %: % -> %',table_name,old_count,new_count;
    end if;
  end loop;
  if exists(select 1 from public.vacancies where normalized_vacancy_id=id) then
    raise exception 'rewrite vacancies retain forbidden self duplicate references';
  end if;
  if exists(select 1 from public.matches
    where state in ('alerted','digested','skipped','applying','applied') and delivered_at is null) then
    raise exception 'delivered application wall was not preserved';
  end if;
  if exists(select 1 from public.matches where state='applied' and application_status is not null) then
    raise exception 'applied rows retain an active application generation status';
  end if;
  if (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')<>14 then
    raise exception 'rewrite public schema does not contain exactly 14 tables';
  end if;
end
$migration_postconditions$;

commit;
