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

<p align="center"><strong>Bun · PostgreSQL · Telegram · Pi AI · Playwright · Typst</strong></p>

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

| Source | Adapter |
|---|---|
| hh.ru | Persistent Playwright browser |
| Habr Career | HTML listings |
| Rabota.ru | HTML listings |
| HireHi | Structured listing data |
| Работа России | Public API |
| Geekjob and Avito | Optional adapters |
| Greenhouse, Lever, Ashby, SmartRecruiters | Configurable company ATS boards |

Source availability depends on network egress and the source's current behavior. An adapter being built in does not
mean it should be enabled in every deployment; probe it from the machine that will actually scrape it.

## Technical overview

Jobseeker is a Bun-workspaces monorepo. Domain and infrastructure packages stay behind explicit dependency
boundaries; the root application composes them.

| Workspace | Responsibility |
|---|---|
| `packages/engine` | Pipeline contracts, bounded concurrency, identity, matching, budgets, and loop policy |
| `packages/store` | Factory-owned PostgreSQL pool and repositories |
| `packages/sources` | Factory-owned vacancy adapters, parsing, browser state, and network allowlists |
| `packages/cv` | CV extraction, structured documents, and Typst PDF rendering |
| `src/` | Configuration, factory composition, cross-domain workflows, AI, Telegram, workers, and entrypoints |

The [workspace dependency graph](docs/dependency-graph.md) documents and enforces the allowed import directions.
PostgreSQL is the only runtime database. `search_units.next_run_at` owns the discovery schedule, and exactly one
process may run with `RUN_JOBS=true`. There is no scheduler lock that makes a second engine loop safe.

## Run your own instance

You will need:

- Bun 1.3.14 or newer;
- PostgreSQL;
- a Telegram bot token and an owner account;
- Chromium for browser-backed sources;
- credentials for at least one Pi AI provider;
- suitable fonts for generated PDFs.

The safe setup path covers database initialization, model credentials, Telegram ownership, browser state, and the
single-engine-loop invariant:

**[Open the self-hosting guide →](docs/self-hosting.md)**

Prefer an agent-assisted start? A coding agent can configure your own instance or help add a vacancy source. Copy
one of these prompts:

### Configure an instance

```text
Clone https://github.com/unitdhda/jobseeker and configure a private local instance. Read and follow
README.md, docs/self-hosting.md, and .env.example; ask me for missing choices and credentials without exposing or
committing secrets. Preserve the single Telegram receiver and single engine-loop invariants, run the documented
validation, verify /health and /ready, and stop for approval before pushing or deploying.
```

### Add a vacancy source

```text
Add <source name and URL> to Jobseeker. First read packages/sources/README.md,
packages/sources/src/contract.ts, packages/engine/src/contracts.ts, packages/sources/src/registry.ts, and the closest
adapter and tests. Follow the VacancyPlatform contracts, injected factory configuration, package boundaries, and
source URL/SSRF helpers; add deterministic tests and documentation, run the validation baseline, and stop for
approval before committing, pushing, deploying, or enabling it.
```

For a quick development checkout after configuration:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun --env-file=.env dist/server.mjs
```

Health endpoints are available at `/health` and `/ready`; readiness includes PostgreSQL connectivity.

## AI providers and cost

Inference goes through [Pi AI](https://github.com/earendil-works/pi-ai). Model selection is configuration, not code:

- `AI_MODEL` handles search-profile and application generation;
- `AI_SCORING_MODEL` handles high-volume vacancy scoring;
- `AI_SCORING_FALLBACK_MODEL` is an optional fallback;
- `AI_AUTH_FILE` points to a provider-keyed credential store.

Built-in providers may use API keys or OAuth credentials. The repository also includes a `claude-cli` provider that
can run Claude Code directly or through a private sidecar. `usage_events` records model IDs, token classes, and
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
| How does the optional Claude Code provider work? | [Claude CLI bridge](docs/claude-cli-bridge.md) |
| How is the VPS sidecar arranged? | [VPS deployment](docs/vps-claude-bridge.md) |
| What is retained in the dormant cloud surface? | [Cloud Run](docs/cloud-run.md) |

## Project status

Jobseeker is a production-used personal service, not a hosted public SaaS. It is designed for a small number of users
per deployment and assumes an operator comfortable with Docker, PostgreSQL, Telegram bots, browser automation, and
model credentials.

The project is under active development. Review the schema, privacy behavior, source adapters, and operations guide
before exposing an instance to other users.
