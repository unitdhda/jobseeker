# Dependency graph

The repository has four workspaces and one executable application layer. Arrows below are compile-time dependencies;
runtime implementations are supplied by the root application through factories and ports.

## Workspace graph

```text
                         ┌──────────────────────────────┐
                         │ root application · src/      │
                         │ config · AI · Telegram       │
                         │ factories · cross-domain flow│
                         └───┬────────┬────────┬────────┘
                             │        │        │
                             ▼        ▼        ▼
                   ┌─────────────┐ ┌────────┐ ┌────────┐
                   │ sources     │ │ store  │ │ cv     │
                   └──────┬──────┘ └──┬───┬─┘ └────────┘
                          │           │   │         ▲
                          ▼           ▼   └─────────┘
                   ┌────────────────────┐
                   │ engine             │
                   │ contracts · policy │
                   │ concurrency · loop │
                   └────────────────────┘
```

Allowed internal dependencies:

```text
sources ──► engine/contracts + engine/concurrency
store   ──► engine/contracts + engine/match-state
store   ──► cv/extract types
engine  ──► no internal workspace
cv      ──► no internal workspace
src     ──► all four workspaces
```

There is deliberately no `sources -> store` edge. `createSourceRegistry` accepts a listing-sink port supplied from
the application-owned `createStore` instance. There is also no `engine -> cv` edge: CV/application generation is a
cross-domain workflow coordinated in `src/workflows.ts`; engine owns matching and state policy, while CV owns
extraction, structured documents, and rendering.

## Factory composition

```text
┌──────────────────────────────┐
│ src/postgres.ts              │
│ createStore(options)         │
└──────────────┬───────────────┘
               │ listing sink
               ▼
┌──────────────────────────────┐
│ src/vacancies/registry.ts    │
│ createSourceRegistry(options)│
└──────────────┬───────────────┘
               │ discovery port
               ▼
┌──────────────────────────────┐
│ src/engine-main.ts           │
│ engine ports + lifecycle     │
└──────────────────────────────┘
```

Each store instance owns its PostgreSQL pool and settings. Each source-registry instance owns its settings, adaptive
pools, and HH browser context. Packages contain no configured singleton and never read `process.env`.

## External implementation dependencies

```text
engine/concurrency ──► p-limit      queue bookkeeping; Jobseeker retains adaptive/keyed policy
sources/http       ──► ipaddr.js    IPv4/IPv6 range classification; Jobseeker retains host/redirect policy
sources/hh         ──► Playwright   one persistent serialized HH browser
store              ──► pg           PostgreSQL pools, transactions, and parameterized queries
cv/extract         ──► mammoth + PDF.js/unpdf
cv/pdf             ──► Typst
```

## Enforced rules

`tests/package-boundaries.test.ts` prevents these regressions:

- anything other than the four declared workspaces;
- package environment reads or imports from the root application;
- source adapters importing PostgreSQL repositories;
- engine importing sources, store, or CV;
- application runtime modules issuing raw PostgreSQL queries.
