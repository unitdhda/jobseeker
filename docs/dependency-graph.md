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
sources ──► engine/contracts
store   ──► engine/contracts + engine/match-state
store   ──► cv/extract types
engine  ──► no internal workspace
cv      ──► no internal workspace
app     ──► all four workspaces
```

There is deliberately no `sources -> store` edge. `createSources` accepts a listing-sink port supplied from the
application-owned `createStore` instance; `packages/app/src/vacancies/providers.ts` registers into that collection
every provider the loaded extensions supplied — the application constructs none itself.

There is also no `app -> sources/examples` edge. The application bundles the generic drivers, never the example
providers: `packages/sources/examples` is a directory a deployment copies into its extensions directory, where the
files bind the toolkit from the injected api rather than importing workspace packages that are never published.
That keeps a catalogue of named employers out of the published application. There is also no
`engine -> cv` edge: CV/application generation is a cross-domain workflow coordinated in
`packages/app/src/workflows.ts`; engine owns matching and state policy, while CV owns extraction, structured
documents, and rendering.

## Factory composition

```text
┌──────────────────────────────────┐
│ app/src/extensions.ts            │
│ loadExtensions() → register(api) │
└──────────────┬───────────────────┘
               │ providers, AI providers, hooks
               ▼
┌──────────────────────────────────┐
│ app/src/postgres.ts              │
│ createStore(options)             │
└──────────────┬───────────────────┘
               │ listing sink
               ▼
┌──────────────────────────────────┐
│ app/src/vacancies/registry.ts    │
│ createSources(options)           │
└──────────────┬───────────────────┘
               │ discovery port
               ▼
┌──────────────────────────────────┐
│ app/src/engine-main.ts           │
│ engine ports + lifecycle         │
└──────────────────────────────────┘
```

Extensions load first, because the provider collection cannot be composed before they have registered. Each store
instance owns its PostgreSQL pool and settings. Each source collection owns its injected runtime context and URL
policy; provider factories own source-specific pools, browser contexts, and settings. Packages contain no
configured singleton and never read `process.env`.

## External implementation dependencies

```text
engine/concurrency          ──► p-limit      queue bookkeeping; Jobseeker retains adaptive/keyed policy
sources/http                ──► ipaddr.js    IPv4/IPv6 range classification; Jobseeker retains host/redirect policy
a deployment's extensions  ──► their own    a browser driver or vendor SDK, installed in extensions/
store                       ──► pg           PostgreSQL pools, transactions, and parameterized queries
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
