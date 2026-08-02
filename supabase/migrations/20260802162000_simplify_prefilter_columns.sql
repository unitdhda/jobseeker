alter table public.prefilter_scores
  rename column embedding_cosine to lexical_cosine;
alter table public.prefilter_scores
  rename column embedding_score to lexical_score;
alter table public.prefilter_scores
  drop column if exists semantic_cosine,
  drop column if exists semantic_score,
  drop column if exists semantic_status;

alter table public.candidate_prefilter_scores
  drop column if exists semantic_cosine,
  drop column if exists semantic_status;
