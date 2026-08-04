# Jobseeker

A PostgreSQL-backed Telegram service that discovers vacancies, normalizes them through source adapters, filters and scores them against an authoritative CV, sends alerts/digests, and generates tailored applications.

## Architecture

The same codebase supports local and cloud execution:

- `src/web.ts` — Telegram polling locally or webhook receiver in Cloud Run.
- `src/worker.ts` — local child-process worker for long-running jobs.
- `src/task-worker.ts` — authenticated Cloud Tasks worker.
- `src/cycle.ts` — finite scheduled scrape cycle.
- `src/profile-refresh.ts` — finite repair job for missing or invalid search profiles.
- `src/vacancies/` — HH, Habr Career, Работа.ру, HireHi, GeekJob, Avito, Работа России, and company ATS adapters.
- `src/vacancies/plan.ts` — folds every user's searches into one shared plan per platform before scraping.
- `src/database.ts` — repository for the seven-table PostgreSQL domain schema.
- `src/ai.ts` / `src/workflows.ts` — direct typed Pi AI calls with schema validation and bounded retries.
- `src/claude-cli.ts` — a Pi AI provider this project adds, bridging completions to the Claude Code CLI.
- `docker/claude-cli/` — the sidecar that serves that bridge over HTTP when the CLI cannot ship in the image.

`supabase/schema.sql` is the schema of record — apply it to an empty database to get a runnable environment.
Incremental migration files are working material and stay out of version control; see
[Operations](docs/operations.md).

Production domain tables:

- `users`
- `profiles`
- `vacancies`
- `user_vacancies`
- `telegram_updates`
- `user_state`
- `usage_events`

There is no SQLite, Flue, Redis, local embedding model, or generic background-task database.

## Discovery plan

Search profiles belong to users, but `vacancies` is shared, so discovery is planned per platform rather than per
user. Equivalent searches from different users are clustered by role vocabulary — across languages, ignoring
grade words, and only where the non-text filters agree — and each cluster is fetched once and recorded for every
user in it, under that user's own search name. Boards that publish their whole listing whatever the query are
enumerated once for everyone rather than once per user. Rotation then walks the shared cluster list, so each
platform costs `users × SEARCH_QUERIES_PER_CYCLE` fetches per cycle while covering more of every profile.

The store is read as a source of its own. A user only ever meets the listings their own searches returned, so
`STORE_LINK_LIMIT_PER_USER` vacancies another user already found are linked to them each cycle, best CV-title
matches first. This costs no request: an already-normalized row goes straight to prefiltering and scoring, and a
candidate that still needs fetching joins the ranked queue under its own source and its normalization quota.

## Age and retention

Advert age comes from the advert: every adapter reads the publication date the source states, never the time we
first saw the listing. hh.ru publishes no date on its search cards, so its adapter takes `datePosted` from the
JobPosting block on the vacancy page, falling back to the visible "Вакансия опубликована ..." line and reporting
the date as unknown rather than inventing one.

Age is carried through the pipeline in bands — today, 1-7, 8-14, 15-30, over 30 days. Past
`PREFILTER_MAX_AGE_DAYS` the prefilter rejects an advert outright however well it matches, on the assumption that
it is filled; inside the limit age only discounts the score (to 0.92 and 0.8), so recency never outranks fit. A
vacancy is re-prefiltered when it crosses a band. The scoring prompt receives the same band and is told to use it
only to separate otherwise comparable matches.

Retention deletes a vacancy once the sources have stopped returning it for `VACANCY_RETENTION_DAYS` and it is
itself that old, keeping anything a user applied to, skipped, or still has waiting for delivery. `vacancies` is
also the deduplication memory, so a plain age cut-off would delete listings that are still advertised and pay to
rediscover, re-score and re-deliver them.

## Runtime ownership

Keep exactly one Telegram receiver and one scrape producer active.

### Local

```env
TELEGRAM_MODE=polling
RUN_JOBS=true
RUN_INITIAL_CYCLE=false
```

### Cloud web

```env
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_ASYNC=true
RUN_JOBS=false
```

### Cloud cycle and task workers

```env
TELEGRAM_MODE=off
RUN_JOBS=false
```

Cloud Tasks concurrency and the scrape advisory lock provide bounded execution. Deployments leave Scheduler paused and do not configure the Telegram webhook automatically.

## AI providers

Inference goes through [Pi AI](https://github.com/earendil-works/pi-ai). Three providers are registered, and a
model identifier of the form `provider/model` selects one:

| Provider | Billing | Needs |
|---|---|---|
| `openai-codex` | ChatGPT subscription over OAuth | `OPENAI_CODEX_AUTH_FILE` or the encrypted cloud OAuth document |
| `openai` | metered API | `OPENAI_API_KEY` |
| `claude-cli` | Claude Code subscription | the `claude` CLI, or a sidecar at `CLAUDE_CLI_ENDPOINT` |

`.env.example` ships every `AI_*_MODEL` blank so the choice is yours; blank falls back to the built-in default for
that role. A provider is inert until a model names it, so registering all three costs nothing.

### The `claude-cli` provider is ours, not upstream

Pi AI has no Claude Code provider, so this repository adds one in `src/claude-cli.ts`. It is not the Anthropic
provider with a different base URL — it does not speak the Anthropic HTTP API at all. It runs the CLI in print mode
(locally, or remotely through the `docker/claude-cli/` sidecar which accepts the same argument list over HTTP and
streams the CLI's NDJSON straight back). The consequences are worth knowing before selecting it:

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

See [Claude CLI bridge](docs/claude-cli-bridge.md) for the mapping, the token-overhead measurements behind
`--system-prompt`/`--tools ""`, and the remaining gaps. [VPS deployment](docs/vps-claude-bridge.md) covers running
the sidecar.

## Development

Requirements:

- Bun 1.3.14+
- PostgreSQL via `DATABASE_URL`
- Chromium for HH browser search
- [Claude Code](https://docs.claude.com/en/docs/claude-code) — **only** when an `AI_*_MODEL` selects `claude-cli/*`.
  Install it with `npm install -g @anthropic-ai/claude-code` and sign in (`claude setup-token` mints a long-lived
  subscription token). Alternatively point `CLAUDE_CLI_ENDPOINT` at the sidecar and install nothing locally.
  Nothing else in the project imports it, so leaving `claude-cli/*` unselected needs no Claude install at all.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:postgres
```

Start the built service:

```bash
bun --env-file=.env --env-file=.env.cloud dist/server.mjs
```

Readiness endpoints:

- `GET /health` — process health
- `GET /ready` — PostgreSQL readiness

## Main configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | Telegram bot credential |
| `TELEGRAM_USER_ID` | Owner user ID |
| `TELEGRAM_MODE` | `polling`, `webhook`, or `off` |
| `SEARCH_PLATFORMS` | Subset of `hh,habr,rabota,hirehi,geekjob,avito,trudvsem,ats` |
| `SEARCH_CLUSTER_SIMILARITY` | Token overlap at which two users' searches are fetched as one |
| `STORE_LINK_LIMIT_PER_USER` | Vacancies the shared store hands to each user per cycle; `0` disables |
| `PREFILTER_MAX_AGE_DAYS` | Advert age past which a vacancy is rejected however well it matches |
| `USER_DAILY_APPLICATION_LIMIT` | Tailored CVs per user per 24h |
| `USER_DAILY_COVER_LETTER_LIMIT` | Deliveries per user per 24h; past the CV limit these are letter-only |
| `VACANCY_RETENTION_DAYS` | How long a vacancy no source still lists is kept |
| `AI_MODEL` | Profile and application model; blank uses the default |
| `AI_SCORING_MODEL` | Batched vacancy-scoring model; blank uses the default |
| `CLAUDE_CLI_PATH` / `CLAUDE_CLI_ENDPOINT` | Local `claude` binary, or the sidecar serving it |
| `CLAUDE_CLI_TOKEN` | Bearer secret shared with that sidecar |
| `SCORING_BATCH_TIMEOUT_SECONDS` | Abort deadline for each scoring worker attempt |
| `SCORING_BATCH_MAX_ATTEMPTS` | Bounded scoring attempts after timeout or failure |
| `SCRAPE_CONCURRENCY` | Bounded concurrent user/platform scrape operations; HH remains serialized |
| `HH_OPERATION_TIMEOUT_SECONDS` | Hard deadline for each serialized HH browser search |
| `OPENAI_CODEX_AUTH_FILE` | Local encrypted OAuth source document |
| `RUNTIME_STATE_ENCRYPTION_KEY` | AES-256-GCM key for cloud OAuth/browser state |
| `HH_BROWSER_DATA_PATH` | HH browser profile directory |
| `TYPST_FONT_PATHS` | Font directories for generated PDFs |

See `.env.example` for bounded limits and optional settings.

## Cloud images

`Dockerfile` exposes two targets:

- `web` — Bun webhook image without Chromium, Typst, PDF parsing or Pi AI.
- `worker` — Bun cycle/task image with Chromium, document generation and Pi AI.

`cloudbuild.yaml` builds both images. `scripts/deploy-gcp.sh` deploys them but intentionally leaves cutover inactive.

## Data and secrets

- PostgreSQL is the only runtime database.
- SQLite files are historical backups only.
- OAuth and browser state are encrypted before storage.
- Never commit `.env`, OAuth documents, database passwords, Telegram tokens, or encryption keys.
- A migration already applied remotely is immutable; regenerate `supabase/schema.sql` instead of rewriting one.
