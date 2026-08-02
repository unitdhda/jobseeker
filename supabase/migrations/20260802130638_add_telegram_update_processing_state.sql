alter table public.telegram_update_receipts
  add column if not exists state text not null default 'processing'
    check (state in ('processing','completed','failed')),
  add column if not exists attempts integer not null default 1,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists last_error text;

create index if not exists telegram_update_receipts_cleanup_idx
  on public.telegram_update_receipts(received_at);
