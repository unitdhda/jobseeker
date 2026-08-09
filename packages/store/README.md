# @jobseeker/store

The PostgreSQL client and every repository of the engine schema (`users`, `cv_documents`, `vacancies`,
`search_units`, `unit_subscriptions`, `matches`, `accounts`, `usage_events`, `user_state`, `telegram_updates`).

The package never reads `process.env`. `createStore` receives the database URL and a `StoreSettings` snapshot of
every knob queries need. Each returned store owns its pool and repository context; tests can construct independent
instances without configuration or pool leakage.

- `client.ts` — instance context, pool, retries, transactions, and advisory locks.
- `store.ts` — `createStore`, repository binding, lifecycle, and instance-scoped admin access.
- `repos.ts` — users/access, CV documents and search profiles, vacancy listings and normalization lifecycle,
  scored reads, digests and alerts, applications, usage, retention, the owner's scraper health summary.
- `engine-repos.ts` — the scheduler's tables: due units, unit runs, demand application, match ingest
  (append-only), state transitions (guarded in the `where` clause — a lost race writes nothing), skip-locked
  scoring claims, daily spend.
- `telegram-repos.ts` — expiring Telegram sessions and durable webhook-update claims.

Source listing shapes come from `@jobseeker/engine/contracts`; persisted CV shapes come from
`@jobseeker/cv/extract`. Runtime modules call named repositories.

Two invariants live here, enforced in SQL:

1. **The delivered wall** — a match in `alerted`, `digested`, `skipped`, `applying`, or `applied` can never be
   re-created or re-delivered; ingest is `on conflict do nothing`, transitions check their source state.
2. **Scores land only on claims** — `saveScore` updates only a row in `queued`, so a lost scoring race is a
   no-op.

Tested through the app's integration suite (`bun run test:postgres`) and the migration gates.
