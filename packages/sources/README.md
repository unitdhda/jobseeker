# `@jobseeker/sources`

Instance-scoped vacancy-source runtime. It owns provider contracts, explicit runtime context, URL/DNS/HTTP security, parsing helpers, shared listing collection, and generic drivers.

It does **not** own concrete employers, PostgreSQL, browsers, environment variables, or a global provider registry.

## Runtime

```ts
import { createSources } from '@jobseeker/sources';

const sources = createSources({
  limits,
  trace,
  errorMessage,
  recordListingCandidate,
});

sources.setProvider(provider);
const platform = sources.getPlatform(provider.id);
```

Each collection is independent. Providers receive `SourceContext` explicitly. Replaced or deleted providers remain in the ownership ledger so their URL declarations continue to cover persisted candidates and their resources are closed exactly once.

## Network boundary

All source traffic must use `SourceContext.http`:

- HTTPS and exact declared hosts only;
- no credentials or explicit ports;
- public-unicast DNS destinations only;
- every redirect revalidated, with same-origin and redirect-count limits;
- declared and streamed response-size limits;
- JSON/HTML media-type validation;
- no raw query, body, or rationale tracing.

Browser extensions must run the same URL and DNS validation before navigation.

## Generic drivers

- `drivers/api` — paginated JSON listing/detail APIs
- `drivers/ats` — configured Greenhouse, Lever, Ashby, and SmartRecruiters boards
- `drivers/company-site` — JSON listing plus canonical HTML detail
- `drivers/jsonld-board` — enumerated listing pages plus schema.org `JobPosting` detail

Concrete providers should use a driver only when its transport and lifecycle genuinely fit.

## Deployment-copyable examples

`examples/` contains 19 reference providers. They are never imported by application runtime.

Use one mode only:

1. Copy the whole folder into one extension subdirectory. Its `index.ts` registers all providers.
2. Copy selected provider files and their shared helpers without `index.ts`.

Combining both modes fails startup on duplicate provider IDs by design.

Copied examples receive workspace runtime values through `toolkit.ts`. Workspace imports in examples are type-only and erased; only `valibot` must be installed beside a copied catalogue.
