# Self-hosting Jobseeker

This guide gets a private Jobseeker instance from a clean checkout to one healthy Telegram receiver and one healthy
engine loop. Read [architecture](architecture.md) for design details and [operations](operations.md) before treating an
instance as production.

> [!WARNING]
> Exactly one process may receive Telegram updates for a bot token, and exactly one process may run with
> `RUN_JOBS=true`. Jobseeker has no scheduler lock that makes two engine loops safe.

## Requirements

- Bun 1.3.14 or newer for `bun install` and package scripts; the app itself runs on Node.js 24+ or Bun
  (with Node, add `--experimental-transform-types` when running `.ts` entrypoints directly);
- PostgreSQL reachable through `DATABASE_URL`;
- a Telegram bot token;
- credentials for at least one model in Pi AI's catalog;
- Chromium or the Playwright browser installed by the worker Docker image;
- fonts available to Typst for PDF generation;
- Docker and Compose for the recommended long-running deployment.

Browser-backed source feasibility depends on network egress. Test sources from the machine that will run discovery,
not only from a laptop.

## 1. Install the repository

```bash
git clone git@github.com:unitdhda/jobseeker.git
cd jobseeker
bun install --frozen-lockfile
```

Validate the checkout before introducing credentials:

```bash
bun run typecheck
bun run test
bun run build
```

## 2. Create the Telegram bot

Use Telegram's BotFather to create a bot and obtain its token. Start a private chat with the bot so Telegram knows the
owner account.

The minimal identity configuration is:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
TELEGRAM_CHAT_ID=
TELEGRAM_MODE=polling
```

For a private owner chat, user and chat IDs must match. Keep the token outside version control and set the environment
file to owner-readable permissions only.

The bot is private by design. Other users send `/request`; the owner approves them with `/ok ID` or `/ok @username`.

## 3. Initialize PostgreSQL

Create an empty PostgreSQL database and apply the schema of record:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql
```

Configure the application:

```dotenv
DATABASE_URL=
POSTGRES_SSL=require
POSTGRES_POOL_MAX=4
```

Use `POSTGRES_SSL=disable` only for a trusted local database. `verify-full` additionally requires
`POSTGRES_CA_CERT`.

`supabase/schema.sql` creates a fresh runnable schema. Historical migration material is not an upgrade API for an
unrelated existing database.

## 4. Configure model access

Jobseeker does not hardcode models. Set both roles:

```dotenv
AI_MODEL=provider/generation-model
AI_THINKING_LEVEL=high
AI_SCORING_MODEL=provider/scoring-model
AI_SCORING_THINKING_LEVEL=medium
```

`AI_MODEL` generates career/search profiles, tailored CV content, and cover letters. `AI_SCORING_MODEL` serves the
higher-volume scoring path and is usually the cheaper model.

### Provider API key

Use the provider's normal environment variable, such as:

```dotenv
OPENAI_API_KEY=
```

Leave unused provider keys unset.

### OAuth credential store

Pi AI OAuth providers read a provider-keyed `auth.json` document:

```dotenv
AI_AUTH_FILE=./auth/auth.json
```

Create credentials through Pi/provider login tooling rather than hand-editing access and refresh tokens. Keep the
file mode `600`. When Supabase runtime-state variables and an encryption key are configured, Jobseeker uses its
private encrypted runtime-state document instead of a plain local credential file.

### Optional Claude Code bridge

A role may select `claude-cli/<model>`. Either install the `claude` executable and set `CLAUDE_CLI_PATH`, or run the
private sidecar and set `CLAUDE_CLI_ENDPOINT` plus its bearer secret.

## 5. Choose vacancy sources

Start conservatively:

```dotenv
SEARCH_PLATFORMS=hh,habr,rabota,hirehi,trudvsem,ozon,rwb
```

Useful source-specific settings include:

```dotenv
HH_AREA_ID=1
PLAYWRIGHT_HEADLESS=true
HH_OPERATION_TIMEOUT_SECONDS=180
TRUDVSEM_REGION=
ATS_BOARDS=
```

Optional `SEARCH_PLATFORMS` values include `geekjob`, `avito`, `ats`, and `yandex`. Every concrete adapter is
application-owned under `src/vacancies/providers/` and registered through the public `@jobseeker/sources` API.
Yandex uses the shared company-site driver; the default-enabled Ozon and RWB providers use `job-api.ozon.ru` and
`career.rwb.ru` JSON APIs respectively.

Do not enable every adapter merely because it exists. Some boards block particular egress networks or return no
listings. `/scraper` exposes the actual funnel after startup.

HH browser state should live on a persistent writable volume in long-running deployments. If HH asks for a captcha,
open the same browser profile interactively, solve it, and return to headless operation.

## 6. Configure PDF rendering

Provide fonts and point Typst at them:

```dotenv
TYPST_FONT_PATHS=./fonts
```

The Docker worker copies the repository's private `fonts/` directory into the image. Those files are intentionally
not committed, so a new deployment must supply them before building.

## 7. Configure ownership and limits

For a single-process local or VPS deployment:

```dotenv
TELEGRAM_MODE=polling
RUN_JOBS=true
BACKGROUND_DELIVERY_ASYNC=false
```

Important bounded settings:

```dotenv
PREFILTER_MIN_SCORE=20
ALERT_SCORE=80
DIGEST_MIN_SCORE=50
USER_DAILY_LLM_BUDGET_CENTS=200
USER_DAILY_APPLICATION_LIMIT=5
USER_DAILY_COVER_LETTER_LIMIT=20
UNIT_CADENCE_FLOOR_MINUTES=30
UNIT_CADENCE_CEILING_MINUTES=720
```

Use `.env.example` as the complete reference. Tune only after measuring the discovery → normalization → lexical
match → score → delivery funnel.

## 8. Run locally

Build and start the server:

```bash
bun run build
bun --env-file=.env dist/server.mjs   # or: node --env-file=.env dist/server.mjs
```

Expected startup signals:

- Telegram polling starts;
- `Engine loop started; search_units.next_run_at owns the schedule.` appears when `RUN_JOBS=true`;
- `/health` returns process health;
- `/ready` reports PostgreSQL persistence.

Do not start a second copy while the first one is polling or running jobs.

## 9. First-use flow

1. Send `/start` to the bot.
2. Upload a CV through `/cv`.
3. Wait for CV extraction and search-profile generation.
4. Configure delivery through `/window`.
5. Use `/scraper` as owner to inspect source and scoring progress.
6. Use `/usage` to inspect model turns, tokens, and catalog cost estimates.

Search units adapt their cadence over time. A quiet first few minutes is not necessarily failure; inspect due units,
normalization, parser errors, and scoring budget before forcing work.

## 10. Docker/VPS deployment

The repository includes:

- a multi-stage `Dockerfile` with a browser-capable worker target;
- a Compose topology with the bot and optional private Claude sidecar;
- a seccomp profile for Chromium;
- health/readiness endpoints;
- documentation for safe ownership handoff.

Release and rollback procedures are in [operations](operations.md). Do not copy live host values into
documentation or source control.

## 11. Production checklist

Before inviting users:

- [ ] PostgreSQL backups exist and restore successfully.
- [ ] Telegram webhook is absent when polling is active.
- [ ] Exactly one process has `RUN_JOBS=true`.
- [ ] Cloud Scheduler is paused unless Cloud Run deliberately owns production.
- [ ] The task queue, if used, is bounded to one concurrent dispatch and one per second.
- [ ] OAuth files, environment files, and encryption keys are not committed.
- [ ] `/health` and `/ready` pass from the running image.
- [ ] The configured model IDs appear in fresh `usage_events`.
- [ ] `/privacy`, `/export_me`, and `/delete_me confirm` match actual retention behavior.
- [ ] HH browser state survives a container recreation.
- [ ] Generated PDFs render with the supplied fonts.

## Next steps

- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [Operations](operations.md)
- [Cloud Run staging](cloud-run.md)
