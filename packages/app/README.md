# @unitdhda/jobseeker

Self-hosted Telegram service that turns a CV into continuous vacancy monitoring: it compiles CV-derived searches,
scrapes the sources you enable, scores each match with an LLM against the CV, delivers alerts and digests over
Telegram, and prepares tailored CVs and cover letters on request.

## Requirements

- Node.js ≥ 23.6 (native TypeScript type stripping is used for extensions) or Bun ≥ 1.3;
- PostgreSQL 15+ — any host: Docker, RDS, Supabase, bare metal;
- a Telegram bot token and your Telegram user id (the owner account);
- credentials for at least one [Pi AI](https://github.com/earendil-works/pi-ai) model provider.

## Quickstart

```bash
npm install @unitdhda/jobseeker

# 1. Configure — environment only, no config files. Minimum:
export DATABASE_URL=postgres://…
export TELEGRAM_BOT_TOKEN=…
export TELEGRAM_USER_ID=…
export AI_MODEL=provider/model            # profile + application generation
export AI_SCORING_MODEL=provider/model    # high-volume vacancy scoring

# Or put those values in .env and add --env-file=.env to every command.

# 2. Initialize an empty database.
npx jobseeker --env-file=.env db init

# 3. Sign in to the model provider (OAuth or API key), or import an existing auth.json.
npx jobseeker --env-file=.env credentials create

# 4. Add vacancy sources: the service registers none by itself.
mkdir extensions   # see the extensions section below

npx jobseeker --env-file=.env doctor
npx jobseeker --env-file=.env start
```

| Command | Does |
|---|---|
| `jobseeker start` | Runs the service: Telegram receiver, engine loop, health endpoints |
| `jobseeker db init` | Applies the packaged `schema.sql` to an empty database |
| `jobseeker credentials create` | Interactive provider login: OAuth (browser or device code) or an API key |
| `jobseeker credentials [path]` | Imports an existing `auth.json` into the credential store |
| `jobseeker refresh-profiles` | Generates missing per-platform search profiles, then exits |
| `jobseeker doctor` | Checks configuration, database, fonts, and extensions |

`/health` and `/ready` are served on `PORT` (default 3000).

## Vacancy sources are extensions

At startup the service loads ESM modules from `./extensions` (override with `JOBSEEKER_EXTENSIONS`). Each module
default-exports `register(api)`; through `api` an extension registers vacancy-source providers and additional AI
providers, hooks startup/shutdown, and reaches the bundled source toolkit — generic drivers for JSON APIs,
first-party career sites, JSON-LD boards, and ATS boards. The application carries the drivers, and a deployment
chooses which employers it follows.

Ready-made providers for ~19 public sources live in the repository under `packages/sources/examples` as files to
copy into the extensions directory, where each registers itself:

```bash
cp -r packages/sources/examples extensions/examples
```

`SEARCH_PLATFORMS` (comma-separated ids) narrows which registered sources actually discover; unset means all of
them. Extensions with heavy dependencies (a Playwright-driven browser source, a local inference bridge) keep those
dependencies in the extensions directory's own `package.json`.

## Operating invariants

- **One process per bot token.** Telegram delivers each update once; a second poller silently splits them.
- **One engine loop.** The loop guards itself with a PostgreSQL advisory lock: a second `RUN_JOBS=true` process
  logs that the lock is held and idles until the holder releases it.
- The schema of record is the packaged `schema.sql`; `jobseeker db init` applies it to an empty database only.
- PDF generation always uses the bundled OFL fonts (JetBrains Mono and Spectral).

All limits and optional settings are documented in the repository's `.env.example`.

## Privacy

CV text, search profiles, matches, and generated artifacts are stored in *your* PostgreSQL database and sent to
*your* configured model provider. The operator is responsible for protecting the database, the bot token, and
model credentials. Users can export (`/export_me`) or delete (`/delete_me confirm`) their data.

MIT © unitdhda — [repository](https://github.com/unitdhda/jobseeker)
