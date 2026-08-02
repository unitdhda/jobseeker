alter table public.user_vacancies drop constraint user_vacancies_pkey;
alter table public.user_vacancies
  alter column vacancy_id drop not null,
  add column source text,
  add column source_id text,
  add column search_name text,
  add column discovered_at timestamptz,
  add column last_discovered_at timestamptz,
  add column candidate_context_hash text,
  add column candidate_listing_hash text,
  add column candidate_regex_score integer,
  add column candidate_lexical_cosine double precision,
  add column candidate_score integer,
  add column candidate_filtered smallint,
  add column candidate_reasons jsonb,
  add column candidate_scored_at timestamptz;

update public.user_vacancies uv set source = v.source, source_id = v.source_id
from public.vacancies v where v.id = uv.vacancy_id;

with latest as (
  select distinct on (d.user_id, c.normalized_vacancy_id)
    d.user_id, c.normalized_vacancy_id vacancy_id, d.search_name, d.first_seen_at,
    d.last_seen_at, d.context_hash, d.listing_hash, d.regex_score,
    d.lexical_cosine, d.combined_score, d.filtered, d.reasons_json, d.scored_at
  from public.candidate_discoveries d
  join public.vacancies c on c.source = d.source and c.source_id = d.source_id
  where c.normalized_vacancy_id is not null
  order by d.user_id, c.normalized_vacancy_id, d.last_seen_at desc
)
update public.user_vacancies uv set
  search_name = l.search_name,
  discovered_at = l.first_seen_at,
  last_discovered_at = l.last_seen_at,
  candidate_context_hash = l.context_hash,
  candidate_listing_hash = l.listing_hash,
  candidate_regex_score = l.regex_score,
  candidate_lexical_cosine = l.lexical_cosine,
  candidate_score = l.combined_score,
  candidate_filtered = l.filtered,
  candidate_reasons = l.reasons_json,
  candidate_scored_at = l.scored_at
from latest l where l.user_id = uv.user_id and l.vacancy_id = uv.vacancy_id;

insert into public.user_vacancies (
  user_id, vacancy_id, source, source_id, search_name, discovered_at,
  last_discovered_at, candidate_context_hash, candidate_listing_hash,
  candidate_regex_score, candidate_lexical_cosine, candidate_score,
  candidate_filtered, candidate_reasons, candidate_scored_at,
  first_relevant_at, updated_at
)
select distinct on (d.user_id, c.normalized_vacancy_id)
  d.user_id, c.normalized_vacancy_id, c.source, c.source_id, d.search_name,
  d.first_seen_at, d.last_seen_at, d.context_hash, d.listing_hash,
  d.regex_score, d.lexical_cosine, d.combined_score, d.filtered,
  d.reasons_json, d.scored_at, d.first_seen_at, d.last_seen_at
from public.candidate_discoveries d
join public.vacancies c on c.source = d.source and c.source_id = d.source_id
where c.normalized_vacancy_id is not null
  and not exists (select 1 from public.user_vacancies uv
    where uv.user_id = d.user_id and uv.vacancy_id = c.normalized_vacancy_id)
order by d.user_id, c.normalized_vacancy_id, d.last_seen_at desc;

insert into public.user_vacancies (
  user_id, vacancy_id, source, source_id, search_name, discovered_at,
  last_discovered_at, candidate_context_hash, candidate_listing_hash,
  candidate_regex_score, candidate_lexical_cosine, candidate_score,
  candidate_filtered, candidate_reasons, candidate_scored_at,
  first_relevant_at, updated_at
)
select d.user_id, null, d.source, d.source_id, d.search_name,
  d.first_seen_at, d.last_seen_at, d.context_hash, d.listing_hash,
  d.regex_score, d.lexical_cosine, d.combined_score, d.filtered,
  d.reasons_json, d.scored_at, d.first_seen_at, d.last_seen_at
from public.candidate_discoveries d
join public.vacancies c on c.source = d.source and c.source_id = d.source_id
where c.normalized_vacancy_id is null;

alter table public.user_vacancies alter column source set not null;
alter table public.user_vacancies alter column source_id set not null;
alter table public.user_vacancies add primary key (user_id, source, source_id);
create unique index user_vacancies_user_normalized_idx
  on public.user_vacancies(user_id, vacancy_id) where vacancy_id is not null;
alter table public.user_vacancies add constraint user_vacancies_source_fkey
  foreign key (source, source_id) references public.vacancies(source, source_id) on delete cascade;

drop table public.candidate_discoveries;
