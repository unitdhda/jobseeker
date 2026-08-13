# Jobseeker — implementation assignment from scratch

This document set is a build specification for recreating the current project from an empty repository. It is based on the repository source, package manifests, SQL schema, tests, deployment files, extension implementations, and user/operations documentation.

It specifies the target behavior, boundaries, implementation order, contracts, persistence model, and acceptance gates. It is not a migration plan and must not be used to start a second production receiver.

## Documents

1. [01-engine.md](01-engine.md) — pure pipeline policy, matching, scheduling, concurrency, and loop.
2. [02-store-and-schema.md](02-store-and-schema.md) — PostgreSQL schema, store factory, repositories, transitions, and integration tests.
3. [03-sources-and-extensions.md](03-sources-and-extensions.md) — provider runtime, SSRF boundary, drivers, examples, HH, and extension API.
4. [04-cv.md](04-cv.md) — extraction, canonical documents, evidence checking, Typst rendering, and parser isolation.
5. [05-application.md](05-application.md) — configuration, AI, workflows, workers, Telegram, HTTP, localization, and engine composition.
6. [06-delivery-and-operations.md](06-delivery-and-operations.md) — packaging, CLI, deployment, security, release, and complete validation plan.

## Product to build

A private, self-hosted Telegram service that:

1. accepts and confirms PDF, DOCX, Markdown, or text CVs;
2. derives an occupation-neutral career profile and provider-specific search profiles;
3. compiles equivalent demand into content-addressed shared search units;
4. discovers listing candidates through deployment extensions;
5. normalizes and deduplicates vacancies globally;
6. evaluates each normalized vacancy through each approved user's deterministic lens;
7. optionally semantically prescores candidates, then performs budgeted full LLM scoring;
8. alerts high scores immediately and includes medium scores in daily digests;
9. creates either a tailored CV PDF or a cover letter on demand;
10. caches delivered artifacts against the authoritative CV hash;
11. supports user access approval, export, deletion, localization, and owner diagnostics.

## Non-negotiable invariants

- PostgreSQL is the only runtime store.
- `packages/app/schema.sql` is the complete schema of record; do not create a migration series.
- Exactly one process receives Telegram updates for a bot token. Polling and webhook ownership must never overlap.
- The engine loop runs only while holding the PostgreSQL session advisory lock `jobseeker-engine-loop`.
- `search_units.next_run_at` is the only discovery schedule; there is no cron scheduler.
- Discovery and judgment are independent runtime lanes.
- Discovery stores shared listings, not user assignments. Matching happens after normalization for every approved user with a current lens.
- Delivered, skipped, applying, and applied matches cannot become fresh deliverables again.
- Domain packages never read `process.env`; the app composition layer injects dependencies and settings.
- Source providers never import PostgreSQL and must fetch through the injected SSRF-safe HTTP client.
- The published application contains generic source drivers but no concrete vacancy-source catalogue.
- Concrete sources and extra AI providers are extensions loaded at runtime.
- User text, CVs, vacancy bodies, raw queries, credentials, tokens, and query-bearing URLs must not be logged.
- Tailored CVs may only rearrange or faithfully paraphrase evidence from the authoritative CV.

## Required repository layout

```text
.
├── .env.example
├── .github/workflows/release.yml
├── docker/
│   ├── README.md
│   ├── seccomp-chromium.json
│   └── vps/{Dockerfile,compose.yaml,package.json}
├── docs/
├── extensions/
│   ├── README.md
│   ├── extension-api.ts
│   ├── hh/
│   └── claude-cli/
├── fonts/
├── packages/
│   ├── engine/{src,tests,package.json,README.md}
│   ├── store/{src,tests,package.json,README.md}
│   ├── sources/{src,examples,tests,package.json,README.md}
│   ├── cv/{src,tests,package.json,README.md}
│   └── app/{src,tests,fonts,bin,schema.sql,vite.config.ts,package.json,README.md}
├── scripts/
├── tests/package-boundaries.test.ts
├── package.json
└── tsconfig.json
```

Generated `dist/`, local `data/`, credentials, deployment `.env`, and deployment extension assets are not source-of-truth files.

## Workspace graph

```text
engine  ── no internal workspace dependency
cv      ── no internal workspace dependency
sources ──> engine/contracts
store   ──> engine/contracts + engine/match-state + cv/extract types
app     ──> engine + store + sources + cv
extensions ──> injected extension API at runtime
```

The root boundary test must reject any other internal direction, domain environment reads, application raw SQL, source adapters inside `packages/sources/src`, or app imports from `packages/sources/examples`.

## External stack

- TypeScript, ESM, strict mode, target ES2024, NodeNext resolution.
- Node.js 23.6+ or Bun 1.3+.
- PostgreSQL 15+ through `pg`.
- Telegram through `grammy`.
- HTTP server through Hono and `@hono/node-server`.
- AI through `@earendil-works/pi-ai`.
- Validation through Valibot.
- Bounded concurrency through `p-limit`.
- Source address classification through `ipaddr.js`.
- CV parsing through PDF.js/unpdf, Mammoth, and node-html-parser.
- PDF rendering through Typst.
- Optional browser source through Playwright in the extension workspace only.

## Decomposed implementation sequence

### Phase 0 — scaffold and enforcement

1. Create the five workspaces and root scripts.
2. Configure strict ESM TypeScript and workspace exports.
3. Add exact dependency declarations; because app bundles workspaces, app must also declare all transitive external runtime dependencies.
4. Implement `tests/package-boundaries.test.ts` first so later work cannot violate dependency direction.
5. Add package-level tests using `node:test` and `node:assert/strict`.

**Gate:** boundary tests and typecheck pass with package skeletons.

### Phase 1 — engine

Implement contracts, canonicalization, unit identity, demand compilation, cadence, fair due-unit selection, match state, prefilter evidence, IDF, learned role equivalence, bounded concurrency, port-driven runtime stages, and independent loop lanes.

**Gate:** every test under `packages/engine/tests` passes. See [01-engine.md](01-engine.md).

### Phase 2 — CV domain

Implement safe format detection and extraction, canonical block provenance/warnings, structured CV schema and repair, deterministic evidence checks, escaped Typst source generation, font-injected rendering, and density fitting.

**Gate:** every test under `packages/cv/tests` passes. See [04-cv.md](04-cv.md).

### Phase 3 — schema and store

Write the complete PostgreSQL schema, factory-owned pool/runtime, repositories, transactional deduplication, guarded match transitions, scoring claims, budgets, sessions, durable webhook claims, delivery snapshots, artifact caching, export, and deletion.

**Gate:** store factory test and PostgreSQL integration test pass. See [02-store-and-schema.md](02-store-and-schema.md).

### Phase 4 — sources runtime

Implement provider contracts, empty instance-scoped collections, URL policy, DNS/public-IP checks, redirect and byte limits, generic API/ATS/company/JSON-LD drivers, and deterministic provider examples.

**Gate:** every test under `packages/sources/tests` passes, including loading copied examples with Node outside the monorepo. See [03-sources-and-extensions.md](03-sources-and-extensions.md).

### Phase 5 — app composition and workflows

Implement config parsing, extension loading, store/source composition, encrypted runtime state, AI credential/model composition, profile generation, demand compilation, matching, semantic prescoring, full scoring, application generation, workers, and engine composition.

**Gate:** workflow, scoring, prescoring, security, extension, and application-schema tests pass. See [05-application.md](05-application.md).

### Phase 6 — Telegram and localization

Implement access middleware, locale catalogues, commands, callbacks, CV confirmation, durable user workflow leases, owner diagnostics, alerts, digests, pagination, indicators, artifact generation/resend, export, and deletion.

**Gate:** i18n, digest, charts, profile-message, workflow-spam, and scraper-status tests pass.

### Phase 7 — CLI, build, package, deployment

Implement CLI one-shots, Hono health/readiness/webhook routes, Vite SSR bundle, worker entries, npm package contents, reference container, release workflow, and operational documentation.

**Gate:** typecheck, unit tests, build, pack smoke test, PostgreSQL integration test, and security checks pass. See [06-delivery-and-operations.md](06-delivery-and-operations.md).

## Definition of done

The recreation is complete only when all of these are true:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:postgres
cd packages/app && npm pack
```

Additionally:

- the packed CLI runs `jobseeker help` under Node;
- `jobseeker db init` initializes only an empty PostgreSQL database;
- `jobseeker doctor` checks required config, runtime, PostgreSQL, fonts, and extensions;
- `/health` reports process health and `/ready` verifies PostgreSQL;
- a second engine instance cannot acquire the singleton lock;
- a deployment has exactly one Telegram receiver;
- copied examples load outside the workspace with only their declared extension dependencies;
- source redirects, private addresses, undeclared hosts, oversized responses, and unsafe URLs are rejected;
- CV extraction and application generation do not persist uploaded files or generated PDF bytes;
- exports and deletion match the stated privacy contract;
- release packaging contains CLI, bundle, fonts, schema, license, and package README.
