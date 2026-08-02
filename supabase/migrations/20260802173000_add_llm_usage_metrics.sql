alter table public.usage_events drop constraint if exists usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check
  check (kind in ('score','application','search-profile','llm'));

alter table public.usage_events
  add column if not exists agent text,
  add column if not exists model text,
  add column if not exists input_tokens bigint not null default 0,
  add column if not exists output_tokens bigint not null default 0,
  add column if not exists cache_read_tokens bigint not null default 0,
  add column if not exists cache_write_tokens bigint not null default 0,
  add column if not exists total_tokens bigint not null default 0,
  add column if not exists cost_usd numeric(14,8) not null default 0;

create index if not exists usage_events_kind_time_idx
  on public.usage_events(kind, occurred_at desc);
