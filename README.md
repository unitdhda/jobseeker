<div align="right">
  <a href="README_RU.md">Русская версия</a>
</div>

# Jobseeker

**A self-hosted Telegram service that continuously finds vacancies, scores them against your CV, and prepares tailored applications.**

Upload a CV once. Jobseeker turns it into searches across multiple job boards, normalizes and deduplicates new
listings, evaluates each vacancy against your experience, and sends the strongest matches to Telegram. When a role
looks promising, request a tailored CV or cover letter directly from the alert.

<p align="center">
  <img src="https://raw.githubusercontent.com/unitdhda/jobseeker/main/docs/assets/jobseeker-telegram.png"
       alt="Jobseeker Telegram alert with a fit score, reasons, gaps, and application actions"
       width="1000">
</p>

<p align="center"><strong>Node/Bun · PostgreSQL · Telegram · Pi AI · Typst</strong></p>

> [!NOTE]
> Jobseeker is in active development. It runs in production for a small group of users, but configuration, adapters,
> and operating procedures may still change.

[How it works](#how-it-works) · [Run your own instance](#run-your-own-instance) ·
[Architecture](docs/architecture.md) · [Troubleshooting](docs/troubleshooting.md) ·
[Operations](docs/operations.md)

## What it does

Jobseeker is not another job-board interface. It is a continuously running search engine built around each user's CV:

1. **Understands the CV** — extracts reusable structured content and generates role-specific search demand.
2. **Monitors job boards** — runs shared, adaptive searches and stores each listing once.
3. **Filters before spending** — rejects weak lexical matches before invoking an LLM.
4. **Scores fit** — evaluates skills, seniority, responsibilities, location, work format, and explicit blockers.
5. **Delivers decisions** — sends high-scoring alerts immediately and collects review-worthy roles into digests.
6. **Helps apply** — prepares a tailored CV or cover letter only when requested.

## How it works

```text
┌──────────────────────────┐     ┌──────────────────────────┐
│ Upload a CV              │     │ Tailored CV or letter    │
└──────────────────────────┘     └──────────────────────────┘
              │                                ▲
              ▼                                │
┌──────────────────────────┐     ┌──────────────────────────┐
│ Compile search demand    │     │ Telegram alert or digest │
└──────────────────────────┘     └──────────────────────────┘
              │                                ▲
              ▼                                │
┌──────────────────────────┐     ┌──────────────────────────┐
│ Monitor job boards       │     │ Budgeted LLM scoring     │
└──────────────────────────┘     └──────────────────────────┘
              │                                ▲
              ▼                                │
┌──────────────────────────┐     ┌──────────────────────────┐
│ Shared vacancy store     │ ──▶ │ Match against each CV    │
└──────────────────────────┘     └──────────────────────────┘
```

Searches are content-addressed: equivalent demand from different users becomes one search unit, while matching and
scoring stay user-specific. New listings are normalized once, tested against every approved user's lexical lens, and
only promising matches enter the LLM queue. Discovery and judgment run independently, so a slow browser source does
not block scoring or Telegram delivery.

[Read the architecture guide →](docs/architecture.md)

## What arrives in Telegram

Each alert is designed to support a decision rather than merely announce a URL:

- a calibrated `0–100` fit score;
- a short assessment of the match;
- concrete reasons the role fits;
- gaps or requirements worth checking;
- the original vacancy link;
- actions for a tailored CV, a cover letter, or skipping the role.

Delivered artifacts are reused while the source CV is unchanged. Requesting the same document again resends it
without another model call; uploading a new CV invalidates the cached version naturally.

## Why Jobseeker

| Capability | What it solves |
|---|---|
| **Continuous discovery** | CV-derived searches run on adaptive schedules instead of relying on manual browsing. |
| **Fit before AI spend** | Cheap lexical matching keeps obviously weak vacancies out of the expensive scoring queue. |
| **Shared discovery** | A listing found for one user can be evaluated for others without fetching it again. |
| **No duplicate delivery** | PostgreSQL state transitions prevent an alerted, digested, skipped, or applied match from resurfacing. |
| **Application artifacts** | Tailored CVs and letters are generated independently and can be resent instantly. |
| **Provider-independent AI** | Scoring and generation can use different models from Pi AI's provider catalog. |
| **Inspectable operation** | Telegram owner commands expose usage, scraper health, parser errors, users, and deployment status. |

## Vacancy sources

**The application registers no vacancy sources of its own.** Sources arrive as extensions: at startup the service
loads ESM modules from `./extensions` (override with `JOBSEEKER_EXTENSIONS`) and calls each module's
default-exported `register(api)`. `@jobseeker/sources` supplies the runtime that reaches them through that `api` —
the provider contract, per-instance registration, explicitly injected context, the HTTPS/SSRF boundary, generic
drivers for the surfaces sites actually expose, and ready-made example providers for about 19 public sources.

| Driver | Source surface | Example providers |
|---|---|---|
| `createApiSource` | Paginated JSON listings with optional JSON detail | Ozon Careers, RWB / Wildberries, MTS Careers |
| `createAtsSource` | Greenhouse, Lever, Ashby, SmartRecruiters boards | Configured `provider:slug` company boards |
| `createCompanySiteSource` | First-party JSON search with HTML vacancy pages | Yandex Careers, VK Careers |
| `createJsonLdBoardSource` | Enumerated boards with schema.org `JobPosting` | Avito Careers, Geekjob, Kontur Careers |
| `createSourceProvider` | Anything else, including browser-backed sources | Habr Career, Rabota.ru, HireHi, Работа России, and hh.ru as the reference `hh` extension (persistent Playwright) |

A provider declares every host it may touch, fetches only through the injected HTTP client, and is registered
independently of whether it participates in discovery: `SEARCH_PLATFORMS` decides that separately, so a source can stay
registered for normalization and URL validation while contributing no new searches. An extension owns its own runtime
dependencies, so a browser-driven source keeps Playwright next to itself instead of in the application.

Source availability depends on network egress and the source's current behavior. An example existing does not mean it
should be enabled in every deployment; probe it from the machine that will actually scrape it.

[Extension guide →](extensions/README.md) · [Provider runtime and driver guide →](packages/sources/README.md)

## Run your own instance

Jobseeker is published as [`@unitdhda/jobseeker`](https://www.npmjs.com/package/@unitdhda/jobseeker) — one command,
configured entirely through the environment:

```bash
npm install @unitdhda/jobseeker

export DATABASE_URL=postgres://… TELEGRAM_BOT_TOKEN=… TELEGRAM_USER_ID=…
export AI_MODEL=provider/model AI_SCORING_MODEL=provider/model

npx jobseeker db init            # apply the packaged schema to an empty database
npx jobseeker credentials create # sign in to a model provider: OAuth, or an API key
npx jobseeker doctor             # config, database, fonts, extensions
npx jobseeker start              # Telegram receiver + engine loop + health endpoints
```

You will need Node.js 23.6+ or Bun 1.3+, PostgreSQL 15+, a Telegram bot token and owner account, and credentials for
at least one Pi AI provider. Fonts for generated PDFs ship inside the package. Vacancy sources do not: add at least
one extension before discovery does anything.

The safe setup path covers database initialization, model credentials, Telegram ownership, source extensions, and the
single-receiver invariant:

**[Open the self-hosting guide →](docs/self-hosting.md)**

Prefer an agent-assisted start? A coding agent can configure your own instance or help add a vacancy source. Copy
one of these prompts:

### Configure an instance

```text
Install @unitdhda/jobseeker from npm and configure a private instance for me. Read and follow its README,
docs/self-hosting.md, and .env.example from https://github.com/unitdhda/jobseeker; ask me for missing choices and
credentials without exposing or committing secrets. Initialize the database with `jobseeker db init`, write an
extension that registers the vacancy sources I choose, preserve the single-Telegram-receiver invariant, and get
`jobseeker doctor` passing plus /health and /ready before handing back.
```

### Add a vacancy source

```text
Add <source name and listing URL> to my Jobseeker instance as a vacancy source. Read extensions/README.md and
packages/sources/README.md from https://github.com/unitdhda/jobseeker first. Probe the public JSON or HTML surface
and show the evidence, then pick the closest reusable driver (or createSourceProvider directly). Write it as an
extension in my extensions directory, declare every host, fetch only through context.http, keep raw queries out of
traces, and install any dependency it needs in that directory. Show me the source's funnel in /scraper before
leaving it enabled.
```

To work on the application itself, clone the repository instead:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun --env-file=.env packages/app/dist/server.mjs   # or: node --env-file=.env packages/app/dist/server.mjs
```

Health endpoints are available at `/health` and `/ready`; readiness includes PostgreSQL connectivity.

## Technical overview

Jobseeker is a Bun-workspaces monorepo that runs on Node or Bun — no Bun-specific APIs are used. Domain and
infrastructure packages stay behind explicit dependency boundaries; the application package composes them and is what
ships to npm.

| Workspace | Responsibility |
|---|---|
| `packages/engine` | Pipeline contracts, bounded concurrency, identity, matching, budgets, and loop policy |
| `packages/store` | Factory-owned PostgreSQL pool and repositories |
| `packages/sources` | Open provider runtime, contracts, SSRF policy, HTTP utilities, and reusable source drivers |
| `packages/cv` | CV extraction, structured documents, and Typst PDF rendering |
| `packages/app` | The published `@unitdhda/jobseeker` package: CLI, configuration, factory composition, cross-domain workflows, AI, Telegram, workers, extension loading, and the schema of record |

The [workspace dependency graph](docs/dependency-graph.md) documents and enforces the allowed import directions.
PostgreSQL is the only runtime database and `packages/app/schema.sql` is its single schema of record — there is no
migration series. `search_units.next_run_at` owns the discovery schedule, and the loop takes a PostgreSQL advisory
lock, so a second `RUN_JOBS=true` process idles instead of duplicating work. Telegram has no such guard: exactly one
process per bot token may receive updates.

## AI providers and cost

Inference goes through [Pi AI](https://github.com/earendil-works/pi-ai). Model selection is configuration, not code:

- `AI_MODEL` handles search-profile and application generation;
- `AI_SCORING_MODEL` handles high-volume vacancy scoring;
- `AI_SCORING_FALLBACK_MODEL` is an optional fallback;
- `AI_AUTH_FILE` points to a provider-keyed credential store.

Built-in providers may use API keys or OAuth credentials, and an extension can register a provider of its own.
`usage_events` records model IDs, token classes, and
catalog cost estimates. For OAuth or subscription providers, those estimates are operational accounting—not
necessarily an invoice.

## Privacy

Jobseeker handles CVs and job-search preferences, so the deployment operator is responsible for protecting its
PostgreSQL database, Telegram token, and model credentials.

- The **Jobseeker server** does not retain the originally uploaded CV file; Telegram may retain files according to
  Telegram's own platform behavior and policies.
- Extracted CV text and structure are stored so searches and applications can be regenerated.
- CV and vacancy text is sent to the configured model provider for profile generation, scoring, and tailoring.
- Cover-letter text and Telegram's file identifier for a delivered PDF may be stored for instant resending; the PDF
  bytes themselves are not stored in PostgreSQL.
- `/export_me` exports retained personal data.
- `/delete_me confirm` removes the user's CV, profiles, matches, artifacts, usage, and delivery settings while keeping
  the access identity.

## Find the right document

| Question | Document |
|---|---|
| How do I install and configure it? | [Self-hosting](docs/self-hosting.md) |
| How do search units, matching, budgets, and delivery work? | [Architecture](docs/architecture.md) |
| Why are there no vacancies, scores, or documents? | [Troubleshooting](docs/troubleshooting.md) |
| How do I validate, deploy, monitor, or roll back production? | [Operations](docs/operations.md) |
| How do I add a vacancy source or an AI provider? | [Extensions](extensions/README.md) |

## Project status

Jobseeker is a production-used personal service, not a hosted public SaaS. It is designed for a small number of users
per deployment and assumes an operator comfortable with Docker, PostgreSQL, Telegram bots, browser automation, and
model credentials.

The project is under active development. Review the schema, privacy behavior, source adapters, and operations guide
before exposing an instance to other users.
