-- Complete schema of record for a fresh PostgreSQL database. This file is intentionally not a migration series.

create table users (
  user_id text primary key check (user_id ~ '^[1-9][0-9]*$'),
  username text,
  first_name text not null default '',
  last_name text,
  status text not null default 'unregistered'
    check (status in ('unregistered','pending','approved','rejected','revoked')),
  is_owner boolean not null default false,
  locale text check (locale in ('en','ru')),
  locale_selected boolean not null default false,
  delivery_settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(delivery_settings) = 'object'),
  digest_snapshot bigint[] not null default '{}',
  last_digest_at timestamptz,
  access_requested_at timestamptz,
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_owner or status = 'approved')
);

create table cv_documents (
  user_id text primary key references users(user_id) on delete cascade,
  cv_sha256 text not null check (cv_sha256 ~ '^[0-9a-f]{64}$'),
  cv_text text not null,
  document_json jsonb not null check (jsonb_typeof(document_json) = 'object'),
  source_format text not null check (source_format in ('pdf','md','txt','docx')),
  original_filename text not null,
  media_type text not null,
  parser_name text not null,
  parser_version text not null,
  search_profiles jsonb not null default '{}'::jsonb check (jsonb_typeof(search_profiles) = 'object'),
  career_profile jsonb check (career_profile is null or jsonb_typeof(career_profile) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pending_cv_imports (
  user_id text primary key references users(user_id) on delete cascade,
  cv_sha256 text not null check (cv_sha256 ~ '^[0-9a-f]{64}$'),
  cv_text text not null,
  document_json jsonb not null check (jsonb_typeof(document_json) = 'object'),
  source_format text not null check (source_format in ('pdf','md','txt','docx')),
  original_filename text not null,
  media_type text not null,
  parser_name text not null,
  parser_version text not null,
  staged_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index pending_cv_imports_expiry_idx on pending_cv_imports(expires_at);

create table vacancies (
  id bigint generated always as identity primary key,
  source text not null check (length(source) between 1 and 64),
  source_id text not null check (length(source_id) between 1 and 512),
  apply_id text unique check (apply_id is null or apply_id ~ '^[a-z]{6}$'),
  lifecycle_status text not null default 'discovered'
    check (lifecycle_status in ('discovered','queued','filtered','normalizing','normalized','duplicate','failed','closed')),
  url text not null,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_checked_at timestamptz,
  next_normalization_at timestamptz not null default now(),
  normalization_attempts integer not null default 0 check (normalization_attempts >= 0),
  normalization_error text,
  listing_search_name text,
  listing_title text,
  listing_summary text,
  listing_payload jsonb,
  listing_hash text check (listing_hash is null or listing_hash ~ '^[0-9a-f]{64}$'),
  normalized_vacancy_id bigint references vacancies(id) on delete set null,
  canonical_fingerprint text,
  name text,
  employer text,
  area text,
  salary_json jsonb check (salary_json is null or jsonb_typeof(salary_json) = 'object'),
  experience_json jsonb check (experience_json is null or jsonb_typeof(experience_json) = 'object'),
  employment text check (employment is null or employment in ('full-time','part-time','contract','temporary','internship','volunteer','other','unspecified')),
  schedule text check (schedule is null or schedule in ('standard','shift','flexible','rotational','other','unspecified')),
  work_format text check (work_format is null or work_format in ('on-site','remote','hybrid','field','other','unspecified')),
  description text,
  key_skills_json jsonb check (key_skills_json is null or jsonb_typeof(key_skills_json) = 'array'),
  source_query text,
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  search_vector tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(name, '') || ' ' || coalesce(employer, '') || ' ' || coalesce(area, '') || ' '
        || coalesce(description, '') || ' ' || coalesce(key_skills_json::text, '')
    )
  ) stored,
  unique (source, source_id),
  check (normalized_vacancy_id is null or normalized_vacancy_id <> id)
);
create index vacancies_canonical_fingerprint_idx on vacancies(canonical_fingerprint) where canonical_fingerprint is not null;
create index vacancies_normalization_queue_idx
  on vacancies(next_normalization_at, id)
  where lifecycle_status in ('discovered','failed');
create index vacancies_refresh_idx on vacancies(last_checked_at, id) where lifecycle_status = 'normalized';
create index vacancies_last_seen_idx on vacancies(last_seen_at, id);
create index vacancies_search_vector_idx on vacancies using gin(search_vector);

create table search_units (
  unit_id text primary key check (unit_id ~ '^[0-9a-f]{64}$'),
  platform text not null check (length(platform) between 1 and 64),
  filter_signature text not null,
  canonical_tokens jsonb not null check (jsonb_typeof(canonical_tokens) = 'array'),
  query_json jsonb not null check (jsonb_typeof(query_json) = 'object'),
  cadence_minutes integer not null check (cadence_minutes > 0),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_novelty_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index search_units_due_idx on search_units(next_run_at, unit_id) where retired_at is null;
create index search_units_platform_idx on search_units(platform, unit_id) where retired_at is null;

create table unit_subscriptions (
  unit_id text not null references search_units(unit_id) on delete cascade,
  user_id text not null references users(user_id) on delete cascade,
  search_name text not null,
  source_search_json jsonb not null check (jsonb_typeof(source_search_json) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (unit_id, user_id)
);
create index unit_subscriptions_user_idx on unit_subscriptions(user_id, unit_id);

create table matches (
  user_id text not null references users(user_id) on delete cascade,
  vacancy_id bigint not null references vacancies(id) on delete cascade,
  state text not null default 'matched'
    check (state in ('matched','queued','scored','alerted','digested','skipped','applying','applied','expired')),
  matched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  queued_at timestamptz,
  score_updated_at timestamptz,
  delivered_at timestamptz,
  lexical_score double precision not null check (lexical_score between 0 and 100),
  regex_score double precision not null check (regex_score between 0 and 100),
  lexical_cosine double precision not null check (lexical_cosine between 0 and 1),
  title_similarity double precision not null check (title_similarity between 0 and 1),
  skill_coverage double precision not null check (skill_coverage between 0 and 1),
  seniority_gap double precision check (seniority_gap is null or seniority_gap between -1 and 1),
  specificity double precision check (specificity is null or specificity between 0 and 1),
  lexical_cosine_idf double precision check (lexical_cosine_idf is null or lexical_cosine_idf between 0 and 1),
  prescore_score double precision check (prescore_score is null or prescore_score between 0 and 100),
  prescore_model text,
  prescore_prompt_version text,
  prescored_at timestamptz,
  prescore_exploration boolean not null default false,
  llm_score double precision check (llm_score is null or llm_score between 0 and 100),
  score_model text,
  score_explanation jsonb check (score_explanation is null or jsonb_typeof(score_explanation) = 'object'),
  primary_track text,
  short_summary text,
  short_reasons jsonb check (short_reasons is null or jsonb_typeof(short_reasons) = 'array'),
  short_gaps jsonb check (short_gaps is null or jsonb_typeof(short_gaps) = 'array'),
  hard_rejection boolean not null default false,
  application_status text check (application_status is null or application_status in ('generating','ready','failed')),
  application_error text,
  application_started_at timestamptz,
  application_ready_at timestamptz,
  application_delivered_at timestamptz,
  application_artifacts jsonb not null default '{}'::jsonb check (jsonb_typeof(application_artifacts) = 'object'),
  primary key (user_id, vacancy_id)
);
create index matches_user_state_idx on matches(user_id, state, updated_at, vacancy_id);
create index matches_user_score_idx on matches(user_id, llm_score desc nulls last, vacancy_id);
create index matches_scoring_queue_idx on matches(user_id, state, lexical_score desc, matched_at, vacancy_id)
  where state = 'matched';
create index matches_alert_queue_idx on matches(user_id, llm_score desc, vacancy_id)
  where state = 'scored' and delivered_at is null;

create table idf_corpora (
  scope text primary key check (scope in ('title','body')),
  documents bigint not null check (documents >= 0),
  unknown_idf double precision not null check (unknown_idf > 0),
  rebuilt_at timestamptz not null default now()
);

create table idf_vocabulary (
  scope text not null references idf_corpora(scope) on delete cascade,
  token text not null,
  idf double precision not null check (idf > 0),
  primary key (scope, token)
);

create table role_equivalences (
  token_a text not null,
  token_b text not null,
  support integer not null check (support > 0),
  rebuilt_at timestamptz not null default now(),
  primary key (token_a, token_b),
  check (token_a < token_b)
);

create table usage_events (
  id bigint generated always as identity primary key,
  user_id text not null references users(user_id) on delete cascade,
  kind text not null check (kind in ('score','application','search-profile','llm')),
  agent text,
  model text,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cost_usd numeric(14,8) not null default 0 check (cost_usd >= 0),
  occurred_at timestamptz not null default now()
);
create index usage_events_kind_time_idx on usage_events(kind, occurred_at desc);
create index usage_events_user_kind_time_idx on usage_events(user_id, kind, occurred_at desc);

create table accounts (
  user_id text not null references users(user_id) on delete cascade,
  day date not null,
  spent_usd numeric(14,8) not null default 0 check (spent_usd >= 0),
  scores integer not null default 0 check (scores >= 0),
  applications integer not null default 0 check (applications >= 0),
  search_profiles integer not null default 0 check (search_profiles >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table user_state (
  user_id text not null references users(user_id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9-]{0,63}$'),
  state jsonb not null,
  token text,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);
create index user_state_expiry_idx on user_state(expires_at);

create table telegram_updates (
  update_id bigint primary key check (update_id >= 0),
  state text not null check (state in ('processing','completed','failed')),
  attempts integer not null default 1 check (attempts > 0),
  lease_expires_at timestamptz,
  error_class text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index telegram_updates_cleanup_idx on telegram_updates(received_at) where state in ('completed','failed');
create index telegram_updates_lease_idx on telegram_updates(lease_expires_at) where state = 'processing';
