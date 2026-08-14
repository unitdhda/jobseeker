<div align="right">
  <a href="README_RU.md">Русская версия</a>
</div>

# Jobseeker

**A self-hosted Telegram service that continuously finds vacancies, scores them against your CV, and prepares tailored applications.**

Upload a CV once. Jobseeker extracts a reusable career profile, compiles shared searches across vacancy sources,
normalizes and deduplicates new listings, and evaluates each vacancy against every approved user's experience. The
strongest matches arrive in Telegram; a tailored CV or cover letter is available directly from the alert.

<p align="center">
  <img src="https://raw.githubusercontent.com/unitdhda/jobseeker/main/docs/assets/jobseeker-telegram.png"
       alt="Jobseeker Telegram alert with a fit score, reasons, gaps, and application actions"
       width="1000">
</p>

<p align="center"><strong>Node/Bun · PostgreSQL · Telegram · Pi AI · Typst</strong></p>

> [!NOTE]
> Jobseeker is in active development. It runs in production for a small group of users, but configuration, extensions,
> schema changes, and operating procedures may still change.

[How it works](#how-it-works) · [Run your own instance](#run-your-own-instance) ·
[Technical overview](#technical-overview) · [Deployment](docker/README.md) · [Extensions](extensions/README.md)

## What it does

Jobseeker is not another job-board interface. It is a continuously running search and application pipeline built
around each user's CV:

1. **Understands the CV** — safely extracts PDF, DOCX, Markdown, or text, previews warnings, and creates an occupation-neutral career profile.
2. **Compiles search demand** — turns provider-specific profiles into content-addressed search units shared by equivalent demand.
3. **Monitors vacancy sources** — runs due searches on adaptive schedules through deployment-owned extensions.
4. **Filters before spending** — applies deterministic user-specific evidence and an optional small semantic model before full scoring.
5. **Scores fit** — evaluates skills, seniority, responsibilities, location, work format, and explicit blockers within per-user budgets.
6. **Delivers decisions** — alerts high scores immediately, collects review-worthy roles into digests, and prepares application artifacts on demand.

## How it works

```text
┌──────────────────────────┐     ┌──────────────────────────┐
│ Upload and confirm a CV  │     │ Tailored CV or letter    │
└──────────────────────────┘     └──────────────────────────┘
              │                                ▲
              ▼                                │
┌──────────────────────────┐     ┌──────────────────────────┐
│ Compile shared demand    │     │ Telegram alert or digest │
└──────────────────────────┘     └──────────────────────────┘
              │                                ▲
              ▼                                │
┌──────────────────────────┐     ┌──────────────────────────┐
│ Extension discovery lane │     │ Budgeted AI scoring      │
└──────────────────────────┘     └──────────────────────────┘
              │                                ▲
              ▼                                │
┌──────────────────────────┐     ┌──────────────────────────┐
│ Shared vacancy store     │ ──▶ │ Match against each CV    │
└──────────────────────────┘     └──────────────────────────┘
```

Equivalent demand from different users becomes one stable search unit, while matching, scoring, and delivery remain
user-specific. Discovery stores globally deduplicated listings; normalization then tests each listing against every
approved user's current lexical lens. Only promising pairs enter semantic prescoring and full scoring. Discovery and
judgment are independent runtime lanes, so a slow source does not block scoring or Telegram delivery.

The only discovery schedule is `search_units.next_run_at`. One process owns the engine loop through PostgreSQL advisory
lock `jobseeker-engine-loop`; Telegram ownership is separate and must be enforced by the operator.

## What arrives in Telegram

Each alert carries what a decision needs:

- a semantic `0–100` fit score;
- a short assessment and score explanation;
- concrete reasons the role fits;
- gaps or requirements worth checking;
- the original vacancy link;
- actions for a tailored CV, a cover letter, or skipping the role.

Delivered artifacts are cached against the authoritative CV hash. Requesting the same artifact again reuses it without
another model call; confirming a new CV invalidates the old cache naturally.

The bot speaks Russian and English. The Telegram client's supported language is used initially, `BOT_LOCALE` is the
fallback, and `/language` stores the user's choice for conversations, alerts, and digests. Model-written scoring and
application text follow the vacancy language.

## Why Jobseeker

| Capability | What it solves |
|---|---|
| **Continuous discovery** | CV-derived searches run on database-owned adaptive schedules. |
| **Fit before AI spend** | Deterministic evidence and optional semantic prescoring bound the expensive scoring queue. |
| **Shared discovery** | A listing found for one user can be evaluated for others without fetching it again. |
| **No duplicate delivery** | Guarded PostgreSQL transitions keep delivered, skipped, applying, and applied matches from resurfacing. |
| **Application artifacts** | Evidence-bound tailored CVs and cover letters are generated independently and can be resent. |
| **Provider-independent AI** | Generation, prescoring, scoring, and fallback models are independently configurable through Pi AI. |
| **Inspectable operation** | Telegram owner commands expose usage, source health, parser errors, users, and deployment status. |
| **Per-user language** | Messages, buttons, command menus, alerts, and digests use each person's stored locale. |

## Vacancy sources

**The application ships no built-in concrete vacancy catalogue.** At startup it loads ESM modules from `./extensions`
(override with `JOBSEEKER_EXTENSIONS`) and calls each module's default-exported `register(api)`. The injected API
provides source and AI-provider registration, lifecycle hooks, scoped logging, bounded concurrency, optional encrypted
state, and the safe source toolkit.

`@jobseeker/sources` owns instance-scoped provider contracts, parsing helpers, and the HTTPS/SSRF boundary. All ordinary
source traffic must use its injected HTTP client: providers declare every host, DNS destinations must be public,
redirects are revalidated, and response sizes and media types are bounded.

| Driver | Source surface |
|---|---|
| `createApiSource` | Paginated JSON listings with optional JSON detail |
| `createAtsSource` | Configured Greenhouse, Lever, Ashby, and SmartRecruiters boards |
| `createCompanySiteSource` | First-party JSON search with canonical HTML vacancy pages |
| `createJsonLdBoardSource` | Enumerated boards with schema.org `JobPosting` detail |
| `createSourceProvider` | Specialized or browser-backed sources that do not fit a generic driver |

The repository includes 19 deployment-copyable reference providers under `packages/sources/examples`; application
runtime never imports them. Use either the complete catalogue or selected provider files, install their extension-local
dependencies, and enable discovery separately with `SEARCH_PLATFORMS`.

Two complete extensions demonstrate the current runtime: `extensions/hh` owns a serialized browser-backed hh.ru source,
and `extensions/claude-cli` registers a local or private-sidecar Pi AI provider. Browser navigation must pass the same
URL and DNS policy as ordinary HTTP traffic, and extension dependencies stay with the extension.

Source availability depends on network egress and the source's current behavior. Probe it from the machine that will
actually perform discovery before leaving it enabled.

[Extension guide →](extensions/README.md) · [Provider runtime and driver guide →](packages/sources/README.md)

## Run your own instance

Jobseeker is published as [`@unitdhda/jobseeker`](https://www.npmjs.com/package/@unitdhda/jobseeker):

```bash
npm install -g @unitdhda/jobseeker

jobseeker --env-file=/path/to/jobseeker.env db init
jobseeker --env-file=/path/to/jobseeker.env credentials create
jobseeker --env-file=/path/to/jobseeker.env doctor
jobseeker --env-file=/path/to/jobseeker.env start
```

Copy [`.env.example`](.env.example) and configure PostgreSQL, Telegram, generation/scoring models, credentials, and at
least one source extension. You need Node.js 23.6+ or Bun 1.3+, PostgreSQL 15+, a Telegram bot token and owner account,
and credentials for at least one Pi AI provider. Fonts for generated PDFs ship in the package.

`db init` applies the packaged schema **only to an empty PostgreSQL `public` schema** and refuses any existing table.
`packages/app/schema.sql` is the sole current schema definition; never rerun initialization over production. Every command
accepts `--env-file`, while existing process environment values take precedence.

Exactly one process may receive updates for a Telegram bot token. In polling mode no webhook may exist; in webhook mode
nothing may poll. The engine advisory lock does not protect Telegram ownership.

For a hardened Node 24 container, Compose topology, backup requirements, upgrades, and rollback, use the
**[reference VPS deployment →](docker/README.md)**.

Prefer an agent-assisted start? Copy this prompt:

```text
Install @unitdhda/jobseeker from npm and configure a private instance for me. Read README.md, .env.example,
docker/README.md, extensions/README.md, and packages/sources/README.md from https://github.com/unitdhda/jobseeker.
Ask for missing choices and credentials without exposing or committing secrets. Initialize only an empty database,
configure deployment-owned source extensions, preserve exactly one Telegram receiver, and get `jobseeker doctor` plus
/health and /ready passing before handing back.
```

To work on the application itself, clone the repository:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:postgres  # requires a dedicated configured test database
```

The deterministic test suite does not load developer environment files or call live models.

## Technical overview

Jobseeker is a strict TypeScript ESM monorepo built with Bun workspaces and runnable on Node or Bun. Domain packages
stay behind enforced import boundaries; `packages/app` composes them and is the package published to npm.

| Workspace | Responsibility |
|---|---|
| `packages/engine` | Pure pipeline contracts, identity, matching, cadence, budgets, concurrency, state, and loop policy |
| `packages/store` | Factory-owned PostgreSQL pool, transactions, locks, and named repositories |
| `packages/sources` | Instance-scoped source runtime, SSRF-safe HTTP, parsing utilities, and generic drivers |
| `packages/cv` | Safe CV extraction, canonical documents, evidence validation, and Typst PDF rendering |
| `packages/app` | CLI, config, composition, AI, workflows, workers, Telegram, HTTP, extensions, and schema of record |

The allowed internal graph is `sources → engine`, `store → engine + cv`, and `app → all domains`; `engine` and `cv` have
no internal workspace dependencies. Domain packages never read `process.env`, source providers never import PostgreSQL,
and application runtime uses named repositories instead of raw SQL.

PostgreSQL is the only runtime store. `packages/app/schema.sql` is the complete fresh-install schema of record rather
than a migration series. Uploaded source files and generated PDF bytes are not persisted. Runtime browser/OAuth state
can be encrypted with AES-256-GCM in compatible object storage.

## AI providers and cost

Inference goes through [Pi AI](https://github.com/earendil-works/pi-ai). Model selection is configuration:

- `AI_MODEL` handles career/search profiles and application generation;
- `AI_SCORING_MODEL` handles full vacancy scoring;
- `AI_PRESCORING_MODEL` optionally supplies a cheaper semantic gate;
- `AI_SCORING_FALLBACK_MODEL` optionally supplies a scoring fallback;
- `AI_AUTH_FILE` points to the provider-keyed credential store.

Built-in providers may use API keys or OAuth; extensions can register additional providers. `usage_events` records
model IDs, token classes, and catalogue cost estimates. For OAuth or subscription providers, those estimates are
operational accounting rather than necessarily an invoice.

## Privacy

Jobseeker handles CVs and job-search preferences, so the deployment operator is responsible for protecting PostgreSQL,
the Telegram token, model credentials, extensions, and runtime-state encryption keys.

- The Jobseeker server does not retain the original uploaded CV file; Telegram may retain it under its own policies.
- Extraction is held as an expiring preview until confirmation; authoritative text and canonical structure are then stored.
- CV and vacancy text is sent to the configured model providers for profile generation, scoring, and tailoring.
- Users share search wording, never names, contacts, or CV text. Matching, scoring, delivery, and artifacts remain user-specific.
- Tailored CVs pass deterministic evidence validation against the authoritative CV.
- Cover-letter text and Telegram's PDF file identifier may be cached; generated PDF bytes are not stored in PostgreSQL.
- `/export_me` exports retained personal data; `/delete_me confirm` removes user-owned CV, profile, match, artifact, usage, and delivery data.

Back up and restore-test PostgreSQL, environment configuration, deployment extensions, and encryption keys before
upgrades.

## Find the right document

| Question | Document |
|---|---|
| How do I deploy, secure, upgrade, or roll back it? | [Reference VPS deployment](docker/README.md) |
| How do I add a vacancy source or AI provider? | [Extensions](extensions/README.md) |
| What is the source runtime and driver contract? | [Sources](packages/sources/README.md) |
| How are CVs extracted, validated, and rendered? | [CV](packages/cv/README.md) |
| How does persistence ownership work? | [Store](packages/store/README.md) |
| How do I operate the published package? | [Application](packages/app/README.md) |

## Project status

Jobseeker is a production-used personal service designed for a small number of users per deployment. It assumes an
operator comfortable with Docker, PostgreSQL, Telegram bots, source extensions, and model credentials.

The project is under active development. Review the schema, privacy behavior, extensions, and deployment guidance
before exposing an instance to other users.
