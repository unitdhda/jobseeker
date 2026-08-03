# Jobseeker

A PostgreSQL-backed Telegram service that discovers vacancies, normalizes them through source adapters, filters and scores them against an authoritative CV, sends alerts/digests, and generates tailored applications.

## Architecture

The same codebase supports local and cloud execution:

- `src/web.ts` — Telegram polling locally or webhook receiver in Cloud Run.
- `src/worker.ts` — local child-process worker for long-running jobs.
- `src/task-worker.ts` — authenticated Cloud Tasks worker.
- `src/cycle.ts` — finite scheduled scrape cycle.
- `src/vacancies/` — HH, Habr Career, Работа.ру, and HireHi adapters.
- `src/database.ts` — repository for the seven-table PostgreSQL domain schema.
- `src/ai.ts` / `src/workflows.ts` — direct typed Pi AI calls using Codex OAuth.

Production domain tables:

- `users`
- `profiles`
- `vacancies`
- `user_vacancies`
- `telegram_updates`
- `user_state`
- `usage_events`

There is no SQLite, Flue, Redis, local embedding model, or generic background-task database.

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

## Development

Requirements:

- Bun 1.3.14+
- PostgreSQL via `DATABASE_URL`
- Chromium for HH browser search

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
| `SEARCH_PLATFORMS` | `hh,habr,rabota,hirehi` |
| `AI_MODEL` | Profile and application model |
| `AI_SCORING_MODEL` | Batched vacancy-scoring model |
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
- Historical Supabase migrations are immutable.
