# @jobseeker/store

The PostgreSQL client and every repository of the engine schema (`users`, `cv_documents`, `vacancies`,
`search_units`, `unit_subscriptions`, `matches`, `accounts`, `usage_events`, `user_state`, `telegram_updates`).

The package never reads `process.env`: the app calls `configureStore` exactly once with the database URL and a
`StoreSettings` snapshot of every knob the queries need (score thresholds, platforms, retention, timezone, the
`safeVacancyUrl` guard). Repositories refuse to run before configuration.

- `client.ts` — pool, transactions, `configureStore`, `storeSettings`.
- `repos.ts` — users/access, CV documents and search profiles, vacancy listings and normalization lifecycle,
  scored reads, digests and alerts, applications, usage, retention, the owner's scraper health summary.
- `engine-repos.ts` — the scheduler's tables: due units, unit runs, demand application, match ingest
  (append-only), state transitions (guarded in the `where` clause — a lost race writes nothing), skip-locked
  scoring claims, daily spend.

Two invariants live here, in SQL rather than convention:

1. **The delivered wall** — a match in `alerted`, `digested`, `skipped`, `applying`, or `applied` can never be
   re-created or re-delivered; ingest is `on conflict do nothing`, transitions check their source state.
2. **Scores land only on claims** — `saveScore` updates only a row in `queued`, so a lost scoring race is a
   no-op, never a corruption.

Tested through the app's integration suite (`bun run test:postgres`) and the migration gates.
