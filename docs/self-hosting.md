# Self-hosting Jobseeker

This guide gets a private Jobseeker instance from an empty database to one healthy Telegram receiver and one healthy
engine loop. Read [architecture](architecture.md) for design details and [operations](operations.md) before treating an
instance as production.

There are two ways to run it, and they differ only in where the code comes from:

- **install the published package** — `@unitdhda/jobseeker` from npm, driven by the `jobseeker` command. This is the
  path below and the one to prefer; you write configuration and extensions, nothing else.
- **run a checkout** — clone the repository when you intend to change the application itself. See
  [Running from a checkout](#running-from-a-checkout) at the end.

> [!WARNING]
> Exactly one process may receive Telegram updates for a bot token. A second poller silently splits updates between
> the two, and Telegram reports nothing wrong. The engine loop is guarded — a second `RUN_JOBS=true` process fails to
> take the PostgreSQL advisory lock, logs that fact, and idles — but the Telegram receiver is not.

## Requirements

- Node.js 23.6 or newer (extensions are loaded as TypeScript through native type stripping) or Bun 1.3+;
- PostgreSQL 15+ reachable through `DATABASE_URL` — Docker, RDS, Supabase, or bare metal, it makes no difference;
- a Telegram bot token and your own Telegram user id;
- credentials for at least one model in [Pi AI](https://github.com/earendil-works/pi-ai)'s catalog;
- whatever your chosen sources need — a browser-backed extension drives a real Chromium through Playwright;
  API-backed sources need nothing beyond network egress.

Fonts for PDF generation ship inside the package (JetBrains Mono and Spectral, both OFL), so nothing is required
there unless you want different ones.

Source feasibility depends on network egress. Probe sources from the machine that will run discovery, because its
egress is what decides which of them work.

## 1. Install

```bash
mkdir jobseeker && cd jobseeker
npm install @unitdhda/jobseeker
npx jobseeker help
```

The package installs a single `jobseeker` command:

| Command | Does |
|---|---|
| `jobseeker start` | Runs the service: Telegram receiver, engine loop, health endpoints. The only long-running mode. |
| `jobseeker db init` | Applies the packaged `schema.sql` to an empty database. |
| `jobseeker credentials create` | Signs in to a model provider: OAuth, or an API key. |
| `jobseeker credentials [path]` | Imports an existing `auth.json` into the credential store. |
| `jobseeker refresh-profiles` | Generates missing per-platform search profiles for approved users, then exits. |
| `jobseeker doctor` | Checks configuration, database, fonts, and extensions. |

Global installation (`npm install -g @unitdhda/jobseeker`) works too, but a project directory is more convenient:
it is where your `extensions/` and environment file will live.

## 2. Configure the environment

Configuration is environment variables only — there is no config file, and the application does not read `.env` by
itself. Supply the variables the way your host does it: `export` in a shell, `EnvironmentFile=` in a systemd unit,
`env_file:` in Compose, or the runtime's own flag:

```bash
node_modules/.bin/jobseeker --env-file=.env start
```

The minimum is five variables:

```dotenv
DATABASE_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
AI_MODEL=provider/generation-model
AI_SCORING_MODEL=provider/scoring-model
```

Copy [`.env.example`](../.env.example) from the repository as the complete annotated reference — every limit,
budget, and cadence knob is documented there with its default.

## 3. Create the Telegram bot

Use Telegram's BotFather to create a bot and obtain its token. Start a private chat with the bot so Telegram knows
the owner account.

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
TELEGRAM_MODE=polling
```

The owner's private-chat id is the same as their user id. Keep the token outside version control and set the
environment file to owner-readable permissions only.

The bot is private by design. Other people send `/request`; the owner approves them with `/ok ID` or `/ok @username`.

## 4. Set up PostgreSQL

Any PostgreSQL 15+ works. Pick whichever of these fits; the rest of the guide is identical afterwards.

### A container next to the service

The simplest self-contained setup. Give it a named volume so the data survives container recreation:

```bash
docker run -d --name jobseeker-db \
  -e POSTGRES_PASSWORD='<choose a strong password>' \
  -e POSTGRES_USER=jobseeker \
  -e POSTGRES_DB=jobseeker \
  -v jobseeker-db:/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 \
  postgres:17
```

Publishing on `127.0.0.1` keeps the database off the public network. If the service runs in Compose alongside it,
publish nothing at all and let them talk over the Compose network by service name.

As a Compose service:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: jobseeker
      POSTGRES_DB: jobseeker
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    volumes:
      - jobseeker-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U jobseeker"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  jobseeker-db:

secrets:
  db_password:
    file: ./db_password.txt   # keep it out of version control
```

With the database on the Compose network, the service reaches it by service name and nothing is published to the
host at all: `DATABASE_URL=postgres://jobseeker:<password>@db:5432/jobseeker` with `POSTGRES_SSL=disable`.

### An existing PostgreSQL server

Create a dedicated database and role — `jobseeker db init` expects the `public`
schema to be empty:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE jobseeker LOGIN PASSWORD 'replace-me';
CREATE DATABASE jobseeker OWNER jobseeker;
SQL
```

### A managed provider

RDS, Cloud SQL, Neon, Supabase, and friends all work; create an empty database and copy the connection string they
give you. Managed providers usually require TLS, which is the default here.

### Point the service at it

```dotenv
DATABASE_URL=postgres://jobseeker:<password>@<host>:5432/jobseeker
POSTGRES_SSL=require
POSTGRES_POOL_MAX=4
```

`POSTGRES_SSL` accepts `require` (default), `verify-full`, and `disable`. Use `disable` only for a database on the
same host or private network; `verify-full` additionally requires `POSTGRES_CA_CERT`. Keep the password out of shell
history and command lines — put it in the environment file, or use a secret file as the Compose example above does.

Then apply the schema of record:

```bash
npx jobseeker db init
```

It prints how many tables it created. `db init` refuses a database that already has tables in `public`: it is an
initializer, and there is no migration series to replay. `schema.sql` is always written whole, as the complete
current schema — so on an existing database you reconcile it against that file. See
[operations](operations.md#upgrading).

Back the database up from the start. It holds every CV, search profile, match, and generated artifact; the schema
can be recreated from the package, but the data cannot.

## 5. Configure model access

Jobseeker hardcodes no models. Set both roles:

```dotenv
AI_MODEL=provider/generation-model
AI_THINKING_LEVEL=high
AI_SCORING_MODEL=provider/scoring-model
AI_SCORING_THINKING_LEVEL=medium
```

`AI_MODEL` generates career/search profiles, tailored CV content, and cover letters. `AI_SCORING_MODEL` serves the
higher-volume scoring path and is usually the cheaper model.

### Signing in to a provider

Credentials live in a store the service owns, and `jobseeker credentials` puts them there. It works the same way
pi's own login does — pick a provider, pick a method, follow the flow:

```bash
npx jobseeker credentials create
```

The list covers every provider in the pi-ai catalog plus any an extension registered, and each one offers whatever
it supports: an OAuth flow (browser or device code, for subscription plans) or an API key, typed invisibly. The
credential is written under the provider's id, which is the same id you name in `AI_MODEL`.

If you already have an `auth.json` — from pi, or from an earlier deployment — import it directly:

```bash
npx jobseeker credentials             # reads AI_AUTH_FILE, or ./auth/auth.json
npx jobseeker credentials ~/.pi/agent/auth.json
```

Both commands need `DATABASE_URL`: writes go through a PostgreSQL advisory lock so an import cannot race a running
instance mid-refresh.

Alternatively, skip the store entirely and give the provider its usual environment variable:

```dotenv
OPENAI_API_KEY=
```

A stored credential wins for its provider; env vars are consulted only where nothing is stored, so you can mix the
two across providers. Leave unused provider keys unset.

### Where credentials are kept

By default the store is a local file, `0600`, written atomically:

```dotenv
AI_AUTH_FILE=./auth/auth.json
```

A local file is lost when a container is recreated, which matters for OAuth providers whose refresh token rotates.
Configure object storage and an encryption key, and Jobseeker keeps the credential document there instead —
encrypted, and serialized across processes:

```dotenv
STATE_STORAGE_URL=
STATE_STORAGE_KEY=
STATE_STORAGE_BUCKET=jobseeker-private-state
RUNTIME_STATE_ENCRYPTION_KEY=   # 32 bytes, hex
```

All four are required together; with any of them missing the credential store stays on local disk. Any endpoint
serving the `/storage/v1/object` route with a bearer key works — Supabase Storage is one such service. **Back up
`RUNTIME_STATE_ENCRYPTION_KEY`**: without it everything already written to that bucket is unreadable.

`jobseeker credentials` writes to whichever of the two is configured and says which one it used, so the same
command bootstraps a fresh bucket and a laptop checkout.

### Providers from extensions

An extension may register further pi-ai providers; a role then selects one by naming its model id, and the provider
reads its own configuration from the environment. This is how a local inference bridge or an unpublished vendor SDK
is wired in without touching the application.

## 6. Add vacancy sources

**The application registers no vacancy sources by itself.** Discovery does nothing until an extension provides
providers. At startup the service scans `./extensions` (override with `JOBSEEKER_EXTENSIONS`) for ESM modules —
single files, or subdirectories with an `index.*` — and calls each module's default-exported `register(api)`.

The bundled `@jobseeker/sources` toolkit reaches extensions through that `api`, supplying the generic drivers.
Ready-made providers for about 19 public sources ship in the repository as files to copy,
not as something the application imports:

```bash
cp -r packages/sources/examples extensions/examples
```

That directory has an `index.ts`, so the loader treats it as one extension and registers every example. To run a
subset instead, copy individual providers next to `toolkit.ts`, `profile.ts`, and `text.ts` and leave `index.ts`
behind — each provider registers itself. Do not do both in one directory: the examples would register twice and
fail on duplicate provider ids.

The examples import `valibot`, so the extensions directory needs it installed (see below).

Node loads `.ts` extensions directly through type stripping, so keep to erasable syntax — no enums, namespaces, or
parameter properties. Extensions own their runtime dependencies: give the extensions directory its own
`package.json` and run `npm install` there, next to the code that needs it. The examples need `valibot`; a browser
or vendor SDK belongs there too.

Narrow what actually runs discovery with a comma-separated list of registered source ids; unset means all of them:

```dotenv
SEARCH_PLATFORMS=habr,rabota,hirehi,trudvsem,ozon,rwb
```

A source can stay registered while contributing no searches — registration still gives normalization and URL
validation for listings already stored. Source-specific settings belong to the extension that reads them, for
example `HH_AREA_ID`, `PLAYWRIGHT_HEADLESS`, and `HH_OPERATION_TIMEOUT_SECONDS` for a browser-backed hh extension,
or `TRUDVSEM_REGION` and `ATS_BOARDS` for example providers.

Do not enable every source merely because an example exists. Some boards block particular egress networks or return
nothing at all. `/scraper` exposes the actual funnel after startup.

A browser-backed source needs its state on a persistent writable volume in long-running deployments. If a source
asks for a captcha, open the same browser profile interactively, solve it, and return to headless operation.

The repository's [`extensions/README.md`](../extensions/README.md) documents the full `api` surface, and
[the provider guide](../packages/sources/README.md) documents the drivers behind it.

## 7. Configure ownership and limits

For a single-process deployment:

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

Tune only after measuring the discovery → normalization → lexical match → score → delivery funnel.

### PDF rendering

The packaged JetBrains Mono and Spectral fonts are always used automatically.

## 8. Check, then run

```bash
npx jobseeker doctor
npx jobseeker start
```

`doctor` verifies the five required variables, the runtime version, PostgreSQL reachability and initialization,
the bundled fonts, and that the extensions directory exists and is non-empty. It exits non-zero when a check fails, so
it works as a deployment gate.

Expected startup signals:

- a line listing the loaded extensions and how many source providers they registered;
- Telegram polling starts;
- `Engine loop started; search_units.next_run_at owns the schedule.` appears when `RUN_JOBS=true`;
- `/health` returns process health on `PORT` (default 3000);
- `/ready` reports PostgreSQL persistence.

If a second instance is already running the loop, the new process logs `Another process holds the engine-loop lock`
and stays idle — which is a configuration mistake to fix.

## 9. First-use flow

1. Send `/start` to the bot.
2. Upload a CV through `/cv`.
3. Wait for CV extraction and search-profile generation.
4. Configure delivery through `/window`, and the interface language through `/language`.
5. Use `/scraper` as owner to inspect source and scoring progress.
6. Use `/usage` to inspect model turns, tokens, and catalog cost estimates.

Search units adapt their cadence over time. A quiet first few minutes is not necessarily failure; inspect due units,
normalization, parser errors, and scoring budget before forcing work.

## 10. Keep it running

Any supervisor that holds one process and restarts it works — systemd, Compose, a process manager. Two rules
survive every choice:

- one process per bot token receives Telegram updates;
- the database backups from step 4 actually restore — test one before you need it.

Upgrades are `npm update @unitdhda/jobseeker` followed by a restart. Compare the packaged `schema.sql` against
your database first: you apply the schema yourself.

## Running from a checkout

Use this when you intend to change the application. The repository is a Bun-workspaces monorepo; the published
package is built from `packages/app`.

```bash
git clone git@github.com:unitdhda/jobseeker.git
cd jobseeker
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun --env-file=.env packages/app/dist/server.mjs   # or: node --env-file=.env packages/app/dist/server.mjs
```

Everything above about configuration, the database, extensions, and ownership applies unchanged; the checkout
carries the example providers under `packages/sources/examples` ready to copy into `extensions/`, and
`packages/app/schema.sql` is the same file the package ships.

Running from a checkout suits development. For a long-running deployment, install the published package — either
under a supervisor, or in the container described by the reference directory under `docker/vps/`, which brings a
Compose topology, an image recipe, and a seccomp profile for Chromium. Release and rollback procedures are in
[operations](operations.md). Do not copy live host values into documentation or source control.

## Production checklist

Before inviting users:

- [ ] PostgreSQL backups exist and restore successfully.
- [ ] Telegram webhook is absent when polling is active.
- [ ] Exactly one process receives Telegram updates.
- [ ] Exactly one process holds the engine-loop lock; no second one is silently idling.
- [ ] `jobseeker doctor` passes on the machine that runs the service.
- [ ] OAuth files, environment files, and encryption keys are not committed.
- [ ] `/health` and `/ready` pass from the running deployment.
- [ ] The configured model IDs appear in fresh `usage_events`.
- [ ] `/privacy`, `/export_me`, and `/delete_me confirm` match actual retention behavior.
- [ ] Browser-backed source state survives a container recreation.
- [ ] Generated PDFs render with the expected fonts.

## Next steps

- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [Operations](operations.md)
