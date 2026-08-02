create table if not exists public.candidate_prefilter_scores (
  user_id text not null,
  source text not null,
  source_id text not null,
  context_hash text not null,
  listing_hash text not null,
  regex_score integer not null check (regex_score between 0 and 100),
  lexical_cosine double precision not null,
  semantic_cosine double precision,
  semantic_status text not null check (semantic_status in ('ready','skipped','disabled','unavailable')),
  combined_score integer not null check (combined_score between 0 and 100),
  filtered smallint not null check (filtered in (0,1)),
  reasons_json text not null,
  scored_at text not null,
  primary key (user_id, source, source_id),
  foreign key (user_id, source, source_id)
    references public.candidate_discoveries(user_id, source, source_id) on delete cascade
);

create index if not exists candidate_prefilter_queue_idx
  on public.candidate_prefilter_scores(user_id, filtered, combined_score desc);
