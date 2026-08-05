# Jobseeker

A PostgreSQL-backed Telegram service that discovers vacancies continuously, normalizes them through source
adapters, matches every new listing against each user's CV-derived vocabulary, scores matches with an LLM under
per-user daily budgets, sends alerts/digests, and generates tailored applications.

## Architecture

A Bun-workspaces monorepo: four packages hold the domain assets, the root app composes them.

| Workspace | Holds |
|---|---|
| [`packages/engine`](packages/engine/) | Pure engine algorithms: search-unit identity, demand compilation, cadence, fair picking, the match state machine |
| [`packages/store`](packages/store/) | The PostgreSQL client and every repository over the engine schema |
| [`packages/sources`](packages/sources/) | The vacancy-platform contract, SSRF guard, and all eight adapters |
| [`packages/cv`](packages/cv/) | CV extraction (`./extract`) and structured-CV PDF rendering (`./pdf`) |
| root `src/` | Composition: config, the engine loop, workflows, Telegram, AI wiring |

Key application modules:

- `src/engine-main.ts` — composes the engine loop from repositories, adapters, the prefilter, and delivery;
  started by `src/web.ts` under `RUN_JOBS=true`. **`search_units.next_run_at` is the only schedule** — there is
  no cron and no advisory lock, so exactly one process may run the loop.
- `src/engine-loop.ts` / `src/engine-runtime.ts` — the loop and its stages over injected ports, testable without
  a database or a scraper.
- `src/telegram/` — the bot in six layers: `api` (instance + send mechanics), `format` (pure rendering),
  `delivery` (alerts/digests), `indicators` (editable progress messages), `actions` (orchestration behind
  commands), `bot` (handlers, flows, lifecycle).
- `src/workflows.ts` — profile generation (which compiles demand into search units on every save), the scoring
  drain, and application tailoring.
- `src/ai.ts` + `src/ai-auth.ts` + `src/ai-plugins/` — Pi AI wiring; see AI providers below.
- `src/postgres.ts` — the store composition root: entrypoints import it for its effect before anything touches a
  repository; all other modules import `@jobseeker/store` directly.
- `src/worker.ts` — local child-process worker for profile refresh and application generation.
- `src/task-worker.ts` — authenticated Cloud Tasks worker (staged, idle).

`supabase/schema.sql` is the schema of record — apply it to an empty database to get a runnable environment.

Domain tables: `users`, `cv_documents`, `vacancies`, `search_units`, `unit_subscriptions`, `matches`,
`accounts`, `usage_events`, `user_state`, `telegram_updates`. The pre-2026-08-05 world survives as the frozen
`legacy` schema until its retirement date; `src/scripts/migration/` holds the tooling that performed the cutover
and its six verification gates.

## Discovery: units, subscriptions, cadence

Users express demand as search profiles; the engine compiles them into **search units** — content-addressed by
platform, canonical role tokens, and filter signature — with **subscriptions** tying users to units under each
user's own search name. Equivalent searches from different users become one unit fetched once for everyone;
compilation is the only clustering moment, so units never re-cluster and identity never drifts. Profile saves
recompile the user's demand: new units are minted or adopted, abandoned subscriptions retire their units.

Each unit runs on its own **cadence**: novelty halves the interval toward `UNIT_CADENCE_FLOOR_MINUTES`, silence
stretches it toward `UNIT_CADENCE_CEILING_MINUTES`. The loop picks due units per platform under a budget of
subscribers × `SEARCH_QUERIES_PER_CYCLE`, serving every due unit's subscribers before spending spare budget on
breadth. A failed platform leaves its units due — retried next tick, never silently skipped.

Discovery writes only shared listings. Who sees a vacancy is decided at **match time**: after normalization,
every approved user's lexical lens (the CV-derived prefilter) judges the new vacancy, and qualifying pairs become
`matches` rows. The match then walks a checked state machine — `matched → queued → scored → alerted/digested/
skipped → applying → applied` — and anything the user has already seen can never be delivered again; the store
enforces the transitions in SQL, not by convention.

Scoring drains each user's best claims under a per-day spend ceiling recorded in `accounts`
(`USER_DAILY_LLM_BUDGET_CENTS`).

## Age and retention

Advert age comes from the advert: every adapter reads the publication date the source states, never the time we
first saw the listing. hh.ru publishes no date on its search cards, so its adapter takes `datePosted` from the
JobPosting block on the vacancy page, falling back to the visible "Вакансия опубликована ..." line and reporting
the date as unknown rather than inventing one.

Age is carried through the pipeline in bands — today, 1-7, 8-14, 15-30, over 30 days. Past
`PREFILTER_MAX_AGE_DAYS` the lens rejects an advert outright however well it matches, on the assumption that it
is filled; inside the limit age only discounts the score, so recency never outranks fit. The scoring prompt
receives the same band and is told to use it only to separate otherwise comparable matches.

Retention deletes a vacancy once the sources have stopped returning it for `VACANCY_RETENTION_DAYS` and it is
itself that old, keeping anything a user applied to, skipped, or still has waiting for delivery. `vacancies` is
also the deduplication memory, so a plain age cut-off would delete listings that are still advertised and pay to
rediscover, re-score and re-deliver them.

## Runtime ownership

Keep exactly one Telegram receiver and exactly one engine loop (`RUN_JOBS=true`) active.

Production is the VPS deployment: one container polling Telegram and running the loop, scoring through the
`claude-cli` sidecar. The Cloud Run surface is deployed and idle. See [VPS deployment](docs/vps-claude-bridge.md)
for the live topology and [Operations](docs/operations.md) for releases.

## AI providers

Inference goes through [Pi AI](https://github.com/earendil-works/pi-ai). The entire built-in provider catalog is
registered behind a credential store, plus one provider of our own; a model identifier of the form
`provider/model` selects one. **No model is hardcoded anywhere**: a role whose `AI_*_MODEL` variable is blank
fails at request time naming the variable.

Credentials come from either the provider's usual environment variable (`OPENAI_API_KEY` and friends) or the
auth.json credential store at `AI_AUTH_FILE` (default `./auth/auth.json`; the encrypted cloud runtime state when
configured) — a JSON document keyed by provider id. A stored credential owns its provider; the environment is
consulted only when nothing is stored. OAuth tokens (e.g. `openai-codex`) live in the store and refresh through
it, serialized in-process and across processes.

### The `claude-cli` provider is ours, not upstream

Pi AI has no Claude Code provider, so this repository adds one in `src/ai-plugins/claude-bridge.ts`. It is not
the Anthropic provider with a different base URL — it does not speak the Anthropic HTTP API at all. It runs the
CLI in print mode (locally, or remotely through the `docker/claude-cli/` sidecar which accepts the same argument
list over HTTP and streams the CLI's NDJSON straight back). The consequences are worth knowing before selecting
it:

| | Anthropic provider | `claude-cli` provider |
|---|---|---|
| Transport | HTTPS to the Anthropic API | child process, or HTTP to the sidecar that spawns it |
| Credential | `ANTHROPIC_API_KEY` | none in this process; the CLI resolves its own subscription OAuth |
| Billing | metered per token | subscription quota; reported cost is notional |
| Tools | caller tools forwarded | not forwarded, and the CLI's own tools are disabled |
| Sessions | stateless per request | stateless; `--no-session-persistence`, no `--resume` |
| Multi-turn | sent as messages | flattened into one labelled prompt |
| Input | text and images | text only |
| Latency floor | one HTTP round trip | ~1–2s of process startup per request |

See [Claude CLI bridge](docs/claude-cli-bridge.md) for the mapping and measurements.
[VPS deployment](docs/vps-claude-bridge.md) covers running the sidecar.

## Development

Requirements:

- Bun 1.3.14+
- PostgreSQL via `DATABASE_URL`
- Chromium for HH browser search
- [Claude Code](https://docs.claude.com/en/docs/claude-code) — **only** when an `AI_*_MODEL` selects
  `claude-cli/*`, or point `CLAUDE_CLI_ENDPOINT` at the sidecar and install nothing locally.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:postgres
```

Start the built service:

```bash
bun --env-file=.env dist/server.mjs
```

Readiness endpoints: `GET /health` (process), `GET /ready` (PostgreSQL).

## Main configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | Telegram bot credential |
| `TELEGRAM_USER_ID` | Owner user ID |
| `TELEGRAM_MODE` | `polling`, `webhook`, or `off` |
| `RUN_JOBS` | Whether this process runs the engine loop; exactly one replica may |
| `SEARCH_PLATFORMS` | Subset of `hh,habr,rabota,hirehi,geekjob,avito,trudvsem,ats` |
| `SEARCH_CLUSTER_SIMILARITY` | Token overlap at which two users' searches compile into one unit |
| `SEARCH_QUERIES_PER_CYCLE` | Per-user share of each platform's per-tick unit budget |
| `UNIT_CADENCE_FLOOR_MINUTES` / `UNIT_CADENCE_CEILING_MINUTES` | How often a unit may run |
| `USER_DAILY_LLM_BUDGET_CENTS` | Per-user daily scoring spend ceiling, from `accounts` |
| `USER_SCORE_LIMIT_PER_CYCLE` | Claims per scoring drain |
| `PREFILTER_MAX_AGE_DAYS` | Advert age past which a vacancy is rejected however well it matches |
| `USER_DAILY_APPLICATION_LIMIT` | Tailored CVs delivered per user per 24h |
| `USER_DAILY_COVER_LETTER_LIMIT` | Cover letters delivered per user per 24h |
| `VACANCY_RETENTION_DAYS` | How long a vacancy no source still lists is kept |
| `AI_MODEL` / `AI_SCORING_MODEL` | Model per role; blank fails at request time by design |
| `AI_AUTH_FILE` | The auth.json credential store |
| `CLAUDE_CLI_PATH` / `CLAUDE_CLI_ENDPOINT` | Local `claude` binary, or the sidecar serving it |
| `CLAUDE_CLI_TOKEN` | Bearer secret shared with that sidecar |
| `SCORING_BATCH_TIMEOUT_SECONDS` | Abort deadline for each scoring worker attempt |
| `SCRAPE_CONCURRENCY` | Bounded concurrent platform scrapes; HH remains serialized |
| `HH_OPERATION_TIMEOUT_SECONDS` | Hard deadline for each serialized HH browser search |
| `RUNTIME_STATE_ENCRYPTION_KEY` | AES-256-GCM key for cloud OAuth/browser state |
| `TYPST_FONT_PATHS` | Font directories for generated PDFs |

See `.env.example` for bounded limits and optional settings.

## Data and secrets

- PostgreSQL is the only runtime database.
- OAuth and browser state are encrypted before storage.
- Never commit `.env`, OAuth documents, database passwords, Telegram tokens, or encryption keys.
- A migration already applied remotely is immutable; regenerate `supabase/schema.sql` instead of rewriting one.
