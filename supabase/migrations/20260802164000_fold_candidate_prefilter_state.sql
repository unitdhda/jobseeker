alter table public.candidate_discoveries
  add column context_hash text,
  add column listing_hash text,
  add column regex_score integer,
  add column lexical_cosine double precision,
  add column combined_score integer,
  add column filtered smallint,
  add column reasons_json jsonb,
  add column scored_at timestamptz;

update public.candidate_discoveries d set
  context_hash = p.context_hash,
  listing_hash = p.listing_hash,
  regex_score = p.regex_score,
  lexical_cosine = p.lexical_cosine,
  combined_score = p.combined_score,
  filtered = p.filtered,
  reasons_json = p.reasons_json,
  scored_at = p.scored_at
from public.candidate_prefilter_scores p
where p.user_id = d.user_id and p.source = d.source and p.source_id = d.source_id;

drop table public.candidate_prefilter_scores;
