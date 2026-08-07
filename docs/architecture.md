# Architecture

Jobseeker is a PostgreSQL-backed Telegram service that continuously turns CV-derived demand into search units,
normalizes shared listings, matches each listing against every approved user, scores promising pairs under a paced
budget, and delivers decisions or application artifacts.

For the product overview, start with the [README](../README.md). For deployment procedures, use the
[operations runbook](operations.md).

## System map

```text
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│ CV upload                        │     │ On-demand tailored CV or letter  │
└──────────────────────────────────┘     └──────────────────────────────────┘
                  │                                         ▲
                  ▼                                         │
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│ Extract structured CV content    │     │ Telegram alerts and digests      │
└──────────────────────────────────┘     └──────────────────────────────────┘
                  │                                         ▲
                  ▼                                         │
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│ Generate career/search profiles  │     │ Paced, budgeted LLM scoring      │
└──────────────────────────────────┘     └──────────────────────────────────┘
                  │                                         ▲
                  ▼                                         │
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│ Compile units + subscriptions    │     │ Match through each user's CV     │
└──────────────────────────────────┘     └──────────────────────────────────┘
                  │                                         ▲
                  ▼                                         │
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│ Discover listings from due units │ ──▶ │ Normalize into the shared store  │
└──────────────────────────────────┘     └──────────────────────────────────┘
```

## Repository boundaries

The repository has four Bun workspaces composed by the executable application layer; the code uses no
Bun-specific APIs, so the built application runs on Node or Bun. See the
[dependency graph](dependency-graph.md) for allowed import directions and factory ownership.

| Workspace | Owns | Does not own |
|---|---|---|
| `@jobseeker/engine` | Pipeline contracts, concurrency policy, identity, cadence, matching, prefiltering, budgets, loop | Database, environment, source implementations, CV files |
| `@jobseeker/store` | Factory-owned PostgreSQL pool and all runtime repositories | Environment parsing, Telegram, source HTTP |
| `@jobseeker/sources` | Open provider runtime, contracts, SSRF/HTTP policy, reusable source drivers | Specific boards, persistence, browsers, model calls |
| `@jobseeker/cv` | File extraction, structured CV coercion, Typst rendering | User state, model selection |
| root `src/` | Vacancy providers, configuration, factory composition, cross-domain workflows, AI and Telegram integrations | Reusable package-level rules |

`createStore` returns an isolated pool/repository instance. `createSources` returns an empty provider collection;
provider factories register through `setProvider`. Collection options contain only shared limits and ports, while
application-owned provider factories own page limits, regions, boards, and browser configuration/state. Discovery,
normalization, and shutdown receive an explicit `SourceContext`; there is no ambient source runtime. Every concrete
source lives under `src/vacancies/providers/` and uses the same public registration API. Reusable API, grouped ATS,
company-site, and JSON-LD wrappers all return ordinary `createSourceProvider` providers without putting a source
catalogue back inside the package. Ozon/RWB, ATS, Yandex, and GeekJob/Avito respectively demonstrate those four
composition paths. The application owns one production store and source collection. Trusted provider metadata is assembled first so the
store and executable collection receive equivalent immutable URL policies without a source/store import cycle.
Source adapters report listings through an injected persistence port and never import PostgreSQL. CV-specific
application generation stays in the root cross-domain workflow, so engine has no dependency on CV.

## Demand and search-unit identity

A source profile contains searches derived from a CV. Compilation converts those searches into:

- a **search unit**, content-addressed by platform, canonical role tokens, and filter signature;
- a **subscription**, connecting one user to that unit while retaining the user's own search name and source query.

Equivalent demand from different users becomes one fetch. Compilation is the only clustering moment: unit identity
does not drift at runtime, and profile regeneration can adopt an existing compatible unit instead of minting a new
one.

`search_units.next_run_at` is the only discovery schedule. A unit that produces novelty tightens its cadence toward
the configured floor; quiet runs stretch it toward the ceiling. Failed source runs remain due rather than being
silently rescheduled as successes.

## Listing-only discovery

Source adapters discover listings without assigning them to users. The shared `vacancies` table carries both listing
and normalized lifecycle state so it can serve as:

- normalization queue;
- canonical listing deduplication memory;
- shared source for users whose searches did not originally find the listing;
- retention boundary for closed or stale adverts.

Source URLs are restricted by explicit HTTPS host allowlists. Adding an adapter also requires adding every remote host
it may contact; redirects are checked again.

HH uses one persistent Playwright browser context. Browser work stays serialized deliberately: parallel contexts make
captcha and profile-state failures more likely. Each page operation has its own deadline so increasing a batch does
not shorten the time available to later pages.

## Match on ingest

After normalization, every approved user with a CV evaluates the new vacancy through their own lexical lens. A
qualifying pair creates one `matches` row with its lexical score.

This is intentionally separate from discovery:

- vacancies are shared;
- CV-derived relevance is private to each user;
- one user's failed matcher cannot block another user's match;
- a listing found for one user can benefit another without another source request.

Advert age comes from the source's publication date. Past `PREFILTER_MAX_AGE_DAYS`, a listing is rejected regardless
of keyword fit. Inside the limit, age discounts relevance but does not outrank role compatibility.

## Match lifecycle and the delivered wall

The checked state machine is:

```text
matched → queued → scored → alerted / digested / skipped
                           ↘ applying → applied
```

Expired rows may be retained as deduplication or decision memory. SQL predicates enforce transitions; application
code cannot simply overwrite an arbitrary state.

The important invariant is the **delivered wall**: a vacancy already alerted, included in a digest, skipped, or
applied to cannot be recreated as a fresh deliverable. Re-running discovery and `createMatches` is therefore safe
with respect to user-visible redelivery.

## Two independent runtime lanes

`src/engine-main.ts` starts one engine loop with two clocks:

### Discovery lane

```text
pick due units → discover listings → normalize queue → match new vacancies
```

Its next wake follows the earliest `search_units.next_run_at`. Browser-backed normalization may take minutes.

### Judgment lane

```text
claim scoring work → score batches → deliver alerts and due digests
```

It wakes every two minutes independently. A slow or failed discovery pass cannot hold scoring or Telegram delivery
behind it.

Exactly one process may run the loop with `RUN_JOBS=true`. There is no scheduler advisory lock; a second process can
perform duplicate source work and delivery.

## Scoring and paced budgets

Scoring claims each user's best queued matches in bounded batches. The prompt applies one rubric across occupations:

- must-have skills;
- seniority and years;
- responsibilities;
- domain;
- location and work format;
- compensation when stated;
- hard blockers.

A hard rejection caps the score below the delivery thresholds. Scores at or above `ALERT_SCORE` alert immediately;
scores from `DIGEST_MIN_SCORE` up to the alert threshold wait for the user's digest. Lower scores are evaluated state,
but normal alerts and digests filter them out.

The daily LLM ceiling is per user. Rather than exposing the entire allowance at midnight, the engine accrues spend
through the UTC day with a small floor fraction. Unused allowance remains available later, preventing morning demand
from exhausting the evening budget.

`accounts` holds budget counters. `usage_events` holds individual operations and LLM token/cost accounting. OAuth and
subscription prices are catalog estimates unless the provider reports authoritative request cost.

## Telegram delivery

Telegram is split into layers:

| Module | Role |
|---|---|
| `api` | Bot instance and send mechanics |
| `format` | Pure HTML and status rendering |
| `delivery` | Alerts, digests, pagination |
| `indicators` | Editable progress messages |
| `actions` | Workflow orchestration |
| `bot` | Commands, callbacks, access lifecycle |

Alerts and digests use plain Telegram HTML. A digest is one message with ten vacancies per page; navigation edits the
same message in place. Apply IDs have a bold minimum unique prefix for human input, while every longer unambiguous
prefix and the full ID resolve as well.

## Application generation and reuse

CV tailoring and cover-letter generation are separate actions with separate limits. After successful delivery, a
match may store:

- the Telegram `file_id` for a tailored PDF;
- the delivered cover-letter text;
- the source CV hash;
- delivery time.

A repeat request with the same CV hash resends the stored artifact without another model call or quota slot. A new CV
changes the hash and forces regeneration. PostgreSQL does not store the generated PDF bytes.

## AI composition

`packages/app/src/ai.ts` registers Pi AI's complete built-in provider catalog plus any provider an extension
registered. Role-specific model IDs come only from configuration:

- `AI_MODEL` — profile and application generation;
- `AI_SCORING_MODEL` — vacancy scoring;
- `AI_SCORING_FALLBACK_MODEL` — optional fallback.

Credentials come from provider environment variables or the provider-keyed credential store. In cloud-enabled
configurations, that document is encrypted in private runtime storage. OAuth refresh is serialized in-process and
with a PostgreSQL transaction lock so rotating refresh tokens cannot be refreshed concurrently by two workers.

## PostgreSQL schema

`supabase/schema.sql` is the schema of record. Core tables:

| Table | Purpose |
|---|---|
| `users` | Access identity and delivery settings |
| `cv_documents` | Extracted CV, structured document, generated profiles |
| `search_units` | Content-addressed source work and cadence |
| `unit_subscriptions` | User demand attached to units |
| `vacancies` | Listings, normalized vacancies, deduplication and parser state |
| `matches` | User-specific relevance, score, delivery, and application state |
| `accounts` | Per-user daily budgets and counters |
| `usage_events` | Usage and model token/cost events |
| `user_state` | Expiring sessions and encrypted operational state references |
| `telegram_updates` | Durable webhook-update processing state |

Source and platform IDs are validated by the application-owned provider collection; `SEARCH_PLATFORMS` is checked
against that collection's provider metadata rather than a second hard-coded ID list. PostgreSQL deliberately does
not repeat the collection as an enum-style `CHECK`, so adding an adapter does not require another schema migration.

## Deployment surfaces

The live surface is one VPS application container polling Telegram and owning the engine loop. A deployment may
run further containers of its own — an inference sidecar an extension talks to, for example — but exactly one
process may poll Telegram and exactly one may run the engine loop.

See [operations](operations.md).
