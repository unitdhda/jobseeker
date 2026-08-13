\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Read-only verification for a migrated clone. Raises on any invariant failure.
begin read only;
set local statement_timeout = '5min';

do $verify$
declare
  relation_name text;
  old_count bigint;
  new_count bigint;
begin
  if not exists(select 1 from pg_namespace where nspname='legacy_0_1_12') then
    raise exception 'legacy schema is missing';
  end if;
  foreach relation_name in array array[
    'users','cv_documents','pending_cv_imports','vacancies','search_units','unit_subscriptions',
    'matches','idf_corpora','idf_vocabulary','role_equivalences','usage_events','accounts',
    'user_state','telegram_updates'
  ] loop
    execute format('select count(*) from legacy_0_1_12.%I',relation_name) into old_count;
    execute format('select count(*) from public.%I',relation_name) into new_count;
    if old_count<>new_count then raise exception 'row count mismatch for %',relation_name; end if;
  end loop;
  if (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')<>14 then
    raise exception 'public table inventory is not exactly 14';
  end if;
  if exists(select 1 from public.users where is_owner and status<>'approved') then
    raise exception 'owner approval invariant failed';
  end if;
  if exists(select 1 from public.cv_documents where jsonb_typeof(document_json)<>'object'
    or jsonb_typeof(search_profiles)<>'object'
    or (career_profile is not null and (career_profile->>'cvHash') is distinct from cv_sha256)) then
    raise exception 'CV/profile envelope invariant failed';
  end if;
  if exists(select 1 from public.cv_documents document cross join lateral jsonb_each(document.search_profiles) profile
    where profile.value->>'cvHash' is distinct from document.cv_sha256
      or profile.value->>'templateVersion'<>'1' or jsonb_typeof(profile.value->'profile')<>'object') then
    raise exception 'source profile envelope invariant failed';
  end if;
  if exists(select 1 from public.vacancies where normalized_vacancy_id=id) then
    raise exception 'vacancy self duplicate survived';
  end if;
  if exists(select 1 from public.vacancies where salary_json is not null and (
    jsonb_typeof(salary_json)<>'object' or salary_json->>'currency' !~ '^[A-Z]{3}$'
    or salary_json->>'period' not in ('hour','day','week','month','year','unspecified'))) then
    raise exception 'salary JSON invariant failed';
  end if;
  if exists(select 1 from public.vacancies where jsonb_typeof(experience_json)<>'object'
    or experience_json->>'kind' not in ('unspecified','range','other')) then
    raise exception 'experience JSON invariant failed';
  end if;
  if exists(select 1 from public.matches where state in ('alerted','digested','skipped','applying','applied') and delivered_at is null) then
    raise exception 'delivered wall invariant failed';
  end if;
  if exists(select 1 from public.matches where state='applied' and application_status is not null) then
    raise exception 'applied rows retain active application status';
  end if;
  if exists(select 1 from public.matches cross join lateral jsonb_each(application_artifacts) item
    where item.key not in ('cv','letter') or item.value->>'cvSha256' !~ '^[0-9a-f]{64}$'
      or item.value->>'deliveredAt' is null
      or ((item.value ? 'fileId')=(item.value ? 'text'))) then
    raise exception 'artifact cache invariant failed';
  end if;
  if exists(select 1 from public.search_units where jsonb_typeof(canonical_tokens)<>'array' or jsonb_typeof(query_json)<>'object') then
    raise exception 'search unit JSON invariant failed';
  end if;
  if exists(select 1 from public.unit_subscriptions where jsonb_typeof(source_search_json)<>'object') then
    raise exception 'subscription JSON invariant failed';
  end if;
  if exists(select 1 from public.usage_events where input_tokens<0 or output_tokens<0 or total_tokens<0 or cost_usd<0) then
    raise exception 'usage bounds invariant failed';
  end if;
  if not exists(select 1 from information_schema.tables where table_schema='legacy_0_1_12' and table_name='calibrations') then
    raise exception 'legacy calibration audit table is missing';
  end if;
end
$verify$;

select json_build_object(
  'ok',true,
  'publicTables',(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'),
  'legacyTables',(select count(*) from information_schema.tables where table_schema='legacy_0_1_12' and table_type='BASE TABLE'),
  'users',(select count(*) from public.users),
  'vacancies',(select count(*) from public.vacancies),
  'matches',(select count(*) from public.matches),
  'usageEvents',(select count(*) from public.usage_events)
);
rollback;
