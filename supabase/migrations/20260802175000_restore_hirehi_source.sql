alter table public.vacancies drop constraint if exists vacancies_source_check;
alter table public.vacancies add constraint vacancies_source_check
  check (source in ('hh','habr','rabota','hirehi'));
