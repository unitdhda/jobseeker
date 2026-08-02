create table public.profiles (
  user_id text primary key references public.telegram_users(user_id) on delete cascade,
  cv_sha256 text not null,
  cv_text text not null,
  document_json jsonb not null,
  source_format text not null,
  original_filename text not null,
  media_type text not null,
  parser_name text not null,
  parser_version text not null,
  search_profiles jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null
);

insert into public.profiles (
  user_id, cv_sha256, cv_text, document_json, source_format, original_filename,
  media_type, parser_name, parser_version, search_profiles, updated_at
)
select c.user_id, c.cv_sha256, c.cv_text, c.document_json, c.source_format,
  c.original_filename, c.media_type, c.parser_name, c.parser_version,
  coalesce((select jsonb_object_agg(s.platform, s.profile_json)
    from public.search_profiles s where s.user_id = c.user_id), '{}'::jsonb),
  greatest(c.updated_at, coalesce((select max(s.updated_at)
    from public.search_profiles s where s.user_id = c.user_id), c.updated_at))
from public.cv_templates c;

alter table public.telegram_users
  add column delivery_start_minutes integer,
  add column delivery_end_minutes integer,
  add column digest_minutes integer,
  add column delivery_timezone text,
  add column last_digest_at timestamptz;

update public.telegram_users u set
  delivery_start_minutes = d.start_minutes,
  delivery_end_minutes = d.end_minutes,
  digest_minutes = d.digest_minutes,
  delivery_timezone = d.timezone,
  last_digest_at = d.last_digest_at
from public.user_delivery_windows d where d.user_id = u.user_id;

alter table public.user_vacancies
  add column prefilter_context_hash text,
  add column prefilter_content_hash text,
  add column prefilter_regex_score integer,
  add column prefilter_lexical_cosine double precision,
  add column prefilter_lexical_score integer,
  add column prefilter_score integer,
  add column prefilter_filtered smallint,
  add column prefilter_audit_selected smallint,
  add column prefilter_reasons jsonb,
  add column prefilter_scored_at timestamptz,
  add column alert_primary_track text,
  add column alert_summary text,
  add column alert_reasons jsonb,
  add column alert_gaps jsonb;

update public.user_vacancies uv set
  prefilter_context_hash = p.context_hash,
  prefilter_content_hash = p.content_hash,
  prefilter_regex_score = p.regex_score,
  prefilter_lexical_cosine = p.lexical_cosine,
  prefilter_lexical_score = p.lexical_score,
  prefilter_score = p.combined_score,
  prefilter_filtered = p.filtered,
  prefilter_audit_selected = p.audit_selected,
  prefilter_reasons = p.reasons_json,
  prefilter_scored_at = p.scored_at
from public.prefilter_scores p
where p.user_id = uv.user_id and p.vacancy_id = uv.vacancy_id;

update public.user_vacancies uv set
  alert_primary_track = d.primary_track,
  alert_summary = d.summary,
  alert_reasons = d.reasons_json,
  alert_gaps = d.gaps_json
from public.score_alert_details d
where d.user_id = uv.user_id and d.vacancy_id = uv.vacancy_id;

drop table public.score_alert_details;
drop table public.prefilter_scores;
drop table public.user_delivery_windows;
drop table public.search_profiles;
drop table public.cv_templates;
