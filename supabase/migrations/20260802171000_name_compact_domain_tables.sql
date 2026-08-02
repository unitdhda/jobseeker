alter table public.telegram_users rename to users;
alter table public.telegram_update_receipts rename to telegram_updates;
alter table public.telegram_sessions rename to user_state;

alter table public.users rename constraint telegram_users_pkey to users_pkey;
alter table public.users rename constraint telegram_users_chat_id_key to users_chat_id_key;
alter table public.telegram_updates rename constraint telegram_update_receipts_pkey to telegram_updates_pkey;
alter table public.user_state rename constraint telegram_sessions_pkey to user_state_pkey;
alter index public.telegram_update_receipts_cleanup_idx rename to telegram_updates_cleanup_idx;
alter index public.telegram_sessions_expiry_idx rename to user_state_expiry_idx;
