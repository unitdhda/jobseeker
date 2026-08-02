alter table public.background_tasks
  add column if not exists max_attempts integer not null default 5,
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz,
  add column if not exists checkpoint jsonb not null default '{}'::jsonb,
  add column if not exists serialization_key text;

alter table public.background_tasks
  drop constraint if exists background_tasks_max_attempts_check,
  add constraint background_tasks_max_attempts_check check (max_attempts between 1 and 25),
  drop constraint if exists background_tasks_attempts_check,
  add constraint background_tasks_attempts_check check (attempts >= 0 and attempts <= max_attempts),
  drop constraint if exists background_tasks_lease_check,
  add constraint background_tasks_lease_check check (
    (state = 'running' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'running' and lease_owner is null and lease_expires_at is null)
  );

update public.background_tasks set available_at=created_at where available_at is null;

drop index if exists public.background_tasks_queue_idx;
create index background_tasks_queue_idx
  on public.background_tasks(state,available_at,created_at)
  where state in ('queued','running');
create index background_tasks_completed_idx
  on public.background_tasks(completed_at)
  where state in ('completed','failed','cancelled');
create index background_tasks_serialization_idx
  on public.background_tasks(serialization_key,state,lease_expires_at)
  where serialization_key is not null and state = 'running';

revoke all on public.background_tasks from anon, authenticated;
