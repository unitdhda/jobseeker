-- Candidate relevance is user-specific and now lives in candidate_prefilter_scores.
alter table public.vacancy_candidates
  drop column if exists prefilter_context_hash,
  drop column if exists regex_score,
  drop column if exists lexical_cosine,
  drop column if exists semantic_cosine,
  drop column if exists semantic_status,
  drop column if exists combined_score,
  drop column if exists filter_reasons_json;
