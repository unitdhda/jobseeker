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

The repository has four domain workspaces composed by the executable application package `packages/app`, which is
what ships to npm as `@unitdhda/jobseeker`; the code uses no Bun-specific APIs, so the built application runs on
Node or Bun. See the [dependency graph](dependency-graph.md) for allowed import directions and factory ownership.

| Workspace | Owns | Does not own |
|---|---|---|
| `@jobseeker/engine` | Pipeline contracts, concurrency policy, identity, cadence, matching, prefiltering, budgets, loop | Database, environment, source implementations, CV files |
| `@jobseeker/store` | Factory-owned PostgreSQL pool and all runtime repositories | Environment parsing, Telegram, source HTTP |
| `@jobseeker/sources` | Open provider runtime, contracts, SSRF/HTTP policy, reusable source drivers | Specific boards, persistence, browsers, model calls |
| `@jobseeker/cv` | File extraction, structured CV coercion, Typst rendering | User state, model selection |
| `packages/app` | CLI, configuration, factory composition, extension loading, cross-domain workflows, AI and Telegram integrations, the schema of record | Reusable package-level rules, concrete vacancy sources |
| `extensions/` | Concrete vacancy-source providers, extra AI providers, and their own runtime dependencies | Anything the application must know about at build time |

`createStore` returns an isolated pool/repository instance. `createSources` returns an empty provider collection;
provider factories register through `setProvider`. Collection options contain only shared limits and ports, while
provider factories own page limits, regions, boards, and browser configuration/state. Discovery, normalization, and
shutdown receive an explicit `SourceContext`; there is no ambient source runtime. **No concrete source lives in the
application at all**: extensions register providers at startup through the same public API, so a deployment's source
set is configuration. Reusable API, grouped ATS, company-site, and JSON-LD wrappers all return
ordinary `createSourceProvider` providers without putting a source catalogue back inside the package; the example
providers shipped with `@jobseeker/sources` demonstrate those four composition paths. The application owns one
production store and source collection. Trusted provider metadata is assembled first so the
store and executable collection receive equivalent immutable URL policies without a source/store import cycle.
Source adapters report listings through an injected persistence port and never import PostgreSQL. CV-specific
application generation stays in the root cross-domain workflow, so engine has no dependency on CV.

## Demand and search-unit identity

A source profile contains searches derived from a CV. Compilation converts those searches into:

- a **search unit**, content-addressed by platform, canonical role tokens, and filter signature;
- a **subscription**, connecting one user to that unit while retaining the user's own search name and source query.

Equivalent demand from different users becomes one fetch. Compilation is the only clustering moment: unit identity
does not drift at runtime, and profile regeneration adopts an existing compatible unit when one already covers the
same demand.

`search_units.next_run_at` is the only discovery schedule. A unit that produces novelty tightens its cadence toward
the configured floor; quiet runs stretch it toward the ceiling. A failed source run leaves its unit due, so the
next tick retries it.

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

`packages/app/src/engine-main.ts` starts one engine loop with two clocks:

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

Exactly one process runs the loop. `RUN_JOBS=true` only expresses intent: the loop starts once its process takes a
PostgreSQL session advisory lock, and a process that fails to take it logs the fact and idles, so duplicate source
work and delivery cannot follow from a second replica.

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

## The prefilter calibrates itself

The budget above is spent best-first, so the order matters as much as the ceiling: whatever the prefilter ranks
highest is what the LLM looks at before the day's allowance runs out. Measured against the LLM's own later verdicts,
the raw lexical score is a weak and non-monotonic predictor of that judgement — bands that *look* stronger do not
reliably score better. Ordering by it wastes budget in a confident-looking way.

So the service learns the ordering from its own history. Every match records the evidence behind it — the role/skill
score and the lexical cosine, frozen at match time — and every LLM score that later arrives is the label for that
evidence. Those pairs are free, accumulate on their own, and describe this deployment's actual occupations rather
than a generic assumption.

Two of those signals are weighted by how unusual a word is across the adverts this deployment has actually seen
(`idf_vocabulary`, rebuilt daily alongside role equivalences). It matters because matching on "designer" — a word
half the board uses — is far weaker evidence than matching on "communication designer", and a token-overlap ratio
cannot tell them apart: it saturates at 1.0 for half of all matches, and that half converted *worse* than the band
beneath it. Rarity is a separate number, because a ratio leaves a full match at 1.0 however common its words are.
The same weighting
applied to the body cosine removes what was largely a document-length meter: the old cosine rose with advert
length while advert quality fell, and the rarity-weighted one is flat across length bands.

Both are recorded as null, never zero, when no vocabulary existed to measure them, and a fit refuses to weigh a
column the corpus does not almost entirely carry. That rule is not caution for its own sake: when a feature
reached 2% of rows and the refit imputed zero for the rest, its fitted coefficient inverted from +3.01 to -0.24.
A constant among varying labels is noise, and a descent will fit noise happily.

Once a day the judgment lane fits a logistic model over them and scores it by cross-validation, with each fold
judged by a model that never trained on it. The candidate replaces the running one **only if it orders at least as
well**, on both ranking quality and precision at the top of the queue. Otherwise it is recorded and discarded. Either
way the attempt lands in `calibrations`, so the history of what was tried and what won is inspectable.

The ordering is computed when the queue is drained. Only the evidence is frozen; the
number derived from it is a function of a model that changes, so freezing that too caused two faults. Rows written
under different models held different quantities in one column and were sorted against each other regardless — on
production, rows averaging 47.9 on a 1..89 range next to rows averaging 31.4 on a 5..74 range. And an accepted
refit only ever reached matches created after it, never the backlog it was fitted to improve. Scoring at claim
time fixes both: one claim compares one quantity, and every accepted refit reorders everything still waiting.
Measured on the production corpus, that alone was worth 20% of the LLM spend at equal yield.

By default the calibration decides only the *order*: admission is still the raw evidence gate
(`PREFILTER_MIN_SCORE`). `PREFILTER_MIN_PROBABILITY` additionally refuses matches whose calibrated probability is
too low, which is the sharper of the two filters because it acts on the signal that was actually measured against
LLM verdicts. It is off by default, because the cost of a gate is paid in matches the user never sees, and the
right height for it is a property of a given deployment's data.

Once a deployment trusts its calibration, the better arrangement is to make the probability the **main** gate and
demote the raw score to a low backstop. Gating hard on the raw score means gating on the weaker signal, and the
two are not interchangeable at equal savings: the same reduction in spend costs several times more delivered
alerts when taken from the raw score. Measure it on your own data before moving
either, because both the raw score's weakness and the calibration's strength are deployment-specific.

The backstop matters. A calibration can be absent — a fresh database, a rejected fit history, a failed load — and
the probability gate simply does not apply when there is none. If `PREFILTER_MIN_SCORE` was lowered on the
assumption that the probability gate would hold the line, that combination admits nearly everything. Matching
logs a single loud error when it finds itself in exactly that state.

Two consequences worth understanding before tuning anything:

- **A calibration can only learn from matches it admits.** Everything rejected is a verdict never observed, so the
  model cannot discover that its own bar is set wrong. `PREFILTER_EXPLORATION_RATE` deliberately scores a small
  random share of rejected matches to buy exactly those labels. It costs model spend in proportion, and it is the
  only mechanism that keeps a blind spot from becoming permanent.
- **The fit runs inside the service.** It yields to the event loop while working, so Telegram and the health
  endpoints stay responsive while it runs.

Rolling back is deliberately dull: turn `CALIBRATION_AUTO_REFIT` off to freeze the current ordering, or mark the
active row in `calibrations` as not accepted and the service falls back to the previous accepted one. Coefficients
are not meant to be hand-written; `PREFILTER_CALIBRATION_JSON` only bootstraps a deployment that has no verdicts of
its own yet.

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

Credentials come from provider environment variables or the provider-keyed credential store. When private runtime
storage is configured, that document is held there encrypted. OAuth refresh is serialized in-process and
with a PostgreSQL transaction lock so rotating refresh tokens cannot be refreshed concurrently by two workers.

## PostgreSQL schema

`packages/app/schema.sql` is the schema of record. Core tables:

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
against that collection's provider metadata. The schema leaves source identity to the collection, so adding an
adapter requires no schema migration.

## Deployment surfaces

The live surface is one application container polling Telegram and owning the engine loop. A deployment may
run further containers of its own — an inference sidecar an extension talks to, for example — but exactly one
process may poll Telegram and exactly one may run the engine loop.

See [operations](operations.md).
