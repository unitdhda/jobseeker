alter table public.vacancies
  alter column apply_id drop not null,
  alter column name drop not null,
  alter column employer drop not null,
  alter column area drop not null,
  alter column experience drop not null,
  alter column employment drop not null,
  alter column schedule drop not null,
  alter column work_format drop not null,
  alter column description drop not null,
  alter column key_skills_json drop not null,
  alter column source_query drop not null,
  alter column content_hash drop not null,
  add column listing_search_name text,
  add column listing_title text,
  add column listing_summary text,
  add column listing_payload jsonb,
  add column listing_hash text,
  add column lifecycle_status text,
  add column normalized_vacancy_id bigint,
  add column normalization_attempts integer not null default 0,
  add column normalization_error text,
  add column normalization_retry_at timestamptz,
  add column last_seen_at timestamptz,
  add column last_checked_at timestamptz;

update public.vacancies set
  listing_search_name = source_query,
  listing_title = name,
  listing_summary = left(description, 1000),
  listing_payload = 'null'::jsonb,
  listing_hash = content_hash,
  lifecycle_status = 'normalized',
  normalized_vacancy_id = id,
  last_seen_at = updated_at,
  last_checked_at = updated_at;

update public.vacancies v set
  url = c.url,
  listing_search_name = c.search_name,
  listing_title = c.title,
  listing_summary = c.summary,
  published_at = c.published_at,
  listing_payload = c.payload_json,
  listing_hash = c.listing_hash,
  lifecycle_status = c.status,
  normalized_vacancy_id = coalesce(c.vacancy_id, case when v.apply_id is not null then v.id end),
  normalization_attempts = c.attempts,
  normalization_error = c.last_error,
  normalization_retry_at = c.next_retry_at,
  last_seen_at = c.last_seen_at,
  last_checked_at = c.last_checked_at
from public.vacancy_candidates c
where c.source = v.source and c.source_id = v.source_id;

insert into public.vacancies (
  source, source_id, url, published_at, first_seen_at, updated_at,
  listing_search_name, listing_title, listing_summary, listing_payload,
  listing_hash, lifecycle_status, normalized_vacancy_id, normalization_attempts,
  normalization_error, normalization_retry_at, last_seen_at, last_checked_at
)
select c.source, c.source_id, c.url, c.published_at, c.first_seen_at, c.last_seen_at,
  c.search_name, c.title, c.summary, c.payload_json, c.listing_hash, c.status,
  c.vacancy_id, c.attempts, c.last_error, c.next_retry_at, c.last_seen_at, c.last_checked_at
from public.vacancy_candidates c
where not exists (select 1 from public.vacancies v where v.source = c.source and v.source_id = c.source_id);

alter table public.candidate_discoveries drop constraint candidate_discoveries_source_source_id_fkey;
drop table public.vacancy_candidates;
alter table public.candidate_discoveries add constraint candidate_discoveries_source_source_id_fkey
  foreign key (source, source_id) references public.vacancies(source, source_id) on delete cascade;
alter table public.vacancies add constraint vacancies_normalized_vacancy_id_fkey
  foreign key (normalized_vacancy_id) references public.vacancies(id) on delete set null;
alter table public.vacancies add constraint vacancies_lifecycle_status_check check (
  lifecycle_status in ('discovered','queued','filtered','normalizing','normalized','duplicate','failed','closed')
);
create index vacancies_normalization_queue_idx on public.vacancies(lifecycle_status, normalization_retry_at, published_at);
