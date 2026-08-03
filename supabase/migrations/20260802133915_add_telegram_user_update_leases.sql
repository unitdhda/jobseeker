create table if not exists public.telegram_user_update_leases (
  user_id text primary key,
  update_id bigint not null,
  lease_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists telegram_user_update_leases_expiry_idx
  on public.telegram_user_update_leases(lease_expires_at);

revoke all on public.telegram_user_update_leases from anon, authenticated;
