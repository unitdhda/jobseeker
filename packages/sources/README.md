# `@jobseeker/sources`

`@jobseeker/sources` is Jobseeker's reusable vacancy-provider runtime. It defines the open provider contract,
instance-scoped registration, explicitly injected runtime context, strict HTTP/SSRF boundary, normalization helpers,
and generic source drivers.

It is deliberately **not a provider catalogue**. Concrete vacancy sources are application concerns. In this repository,
they live under `src/vacancies/providers/` and are composed by `src/vacancies/providers.ts`. An external application can
register its own providers through exactly the same public API.

Ozon, RWB, Yandex, Avito, HH, and the other built-in application sources are examples of providers assembled above
this package; their identities, hosts, codecs, browser ownership, and deployment settings do not belong here.

## Package boundary

The package owns:

- provider and search-platform contracts;
- empty, instance-scoped provider collections;
- explicit source runtime ports and limits;
- provider URL policies and bounded HTTP helpers;
- reusable parsing and normalization utilities;
- generic API, ATS, company-site, and JSON-LD board drivers.

The application owns:

- concrete source IDs and display names;
- source-specific schemas, prompts, codecs, selectors, and URL builders;
- customer ATS board slugs;
- browser configuration and browser lifecycle implementations;
- environment variables and discovery enablement;
- PostgreSQL composition, Telegram behavior, and deployment policy.

Accordingly, `@jobseeker/sources` never reads `process.env`, imports the root application or PostgreSQL, owns a global
provider registry, or registers a source implicitly.

## Public architecture

```text
application provider factory
        │
        ├── createSourceProvider() directly
        │
        └── reusable driver ──> createSourceProvider()
                                 │
                                 ▼
                         SourceProvider
                                 │ setProvider()
                                 ▼
                    instance-scoped Sources collection
                                 │
              explicit SourceContext + collection URL policy
                                 │
                                 ▼
                   engine-facing VacancyPlatform
```

Every driver returns an ordinary `SourceProvider`. Driver-backed, direct, application-owned, and externally supplied
providers therefore share registration, validation, lifecycle, URL security, discovery, and normalization semantics.

## Main modules

| Module | Responsibility |
|---|---|
| `contract.ts` | Search-platform metadata, validation template, plan, and discovery-result contracts |
| `sources.ts` | `createSourceProvider()`, `createSources()`, registration, runtime binding, and lifecycle |
| `context.ts` | Explicit limits, tracing, candidate persistence port, error formatting, and scoped HTTP client |
| `http.ts` | HTTPS/SSRF policy, DNS and redirect validation, response limits, collectors, and normalization helpers |
| `drivers/api.ts` | Paginated JSON listing and optional JSON detail mechanics |
| `drivers/ats.ts` | Grouped Greenhouse, Lever, Ashby, and SmartRecruiters mechanics |
| `drivers/company-site.ts` | First-party JSON search plus HTML vacancy-detail mechanics |
| `drivers/jsonld-board.ts` | Enumerated HTML boards with schema.org `JobPosting` detail pages |

## Provider contract

A provider declares stable identity and capabilities, then implements discovery and batch normalization:

```ts
interface SourceProvider<S> extends SearchPlatform<S> {
  discover(plan, context): Promise<PlatformDiscoveryResult>;
  normalize(candidates, context): Promise<Map<string, VacancyInput | null | Error>>;
  close?(context): Promise<void> | void;
}
```

Create one with `createSourceProvider()`:

```ts
import { createSourceProvider } from '@jobseeker/sources';

export function exampleSource() {
  return createSourceProvider({
    id: 'example',
    name: 'Example Careers',
    hosts: ['careers.example.com'],
    schema: exampleSearchProfileSchema,
    template: () => exampleValidationTemplate,

    async discover(plan, context) {
      // Fetch only through context.http and persist through
      // context.recordListingCandidate.
      return {
        searches: plan.searches.length,
        users: new Set(plan.searches.flatMap((item) =>
          item.recipients.map((recipient) => recipient.userId))).size,
        seen: 0,
        discovered: 0,
      };
    },

    async normalize(candidates, context) {
      const results = new Map();
      for (const candidate of candidates) {
        // Return VacancyInput, null for a closed/unusable vacancy, or Error.
        results.set(candidate.sourceId, null);
      }
      return results;
    },
  });
}
```

`createSourceProvider()` snapshots and deduplicates the declared hosts. It also rejects a normalization batch containing
a candidate whose `candidate.source` differs from the provider ID. Providers should return fresh instances when they
own mutable state or lifecycle resources.

## Explicit runtime context

Providers are inert definitions until a collection invokes them. Each invocation receives a `SourceContext` containing:

- `limits.searchNewVacancyLimit`;
- `limits.searchPageBudgetPerPlatform`;
- `recordListingCandidate()`;
- `trace()`;
- `errorMessage()`;
- `http`, scoped to the collection's URL policy.

There is no ambient source context or asynchronous global state. Two collections can register providers with the same
ID and retain independent runtime ports, host policies, settings, and lifecycle.

Provider-specific settings belong in provider factory arguments. Collection-wide operational limits and ports belong
in `createSources()`.

## Generic registration

Every collection starts empty:

```ts
import { createSources } from '@jobseeker/sources';

const sources = createSources({
  limits: {
    searchNewVacancyLimit: 10,
    searchPageBudgetPerPlatform: 12,
  },
  trace,
  errorMessage,
  recordListingCandidate,
});

for (const provider of applicationProviders) {
  sources.setProvider(provider);
}
```

Registration is open and instance-scoped:

- `setProvider(provider)` inserts or replaces by ID;
- `getProvider(id)` returns the raw provider definition;
- `getPlatform(id)` returns the runtime-bound `VacancyPlatform` used by workflows and the engine;
- `platformIds` is a registration-order snapshot;
- `deleteProvider(id)` and `clearProviders()` remove active registration;
- `close()` idempotently closes every provider the collection has owned, including replaced or deleted instances.

A collection cannot be modified after closing.

Registration and discovery enablement are separate concerns. Applications commonly register every provider needed for
normalization and URL validation while selecting a smaller operator-configured set for new discovery. This package does
not read or interpret `SEARCH_PLATFORMS`.

## URL and SSRF policy

A provider must declare every remote host it may access. Registration derives a collection-owned policy from those
trusted declarations. Providers cannot mutate another collection's policy, and there is no process-global host map.

The HTTP layer enforces:

- HTTPS source URLs;
- declared source hosts;
- public-unicast DNS destinations;
- redirect revalidation;
- bounded declared and streamed response sizes;
- source-specific canonical URL validation.

Use only `context.http.fetchSourceJson()`, `context.http.fetchSourceHtml()`, and
`context.http.safeVacancyUrl()` for remote source data and stored vacancy URLs. Do not bypass these helpers with raw
`fetch()` in a concrete provider.

A collection retains host declarations from providers it has owned. This preserves policy and lifecycle correctness for
historical candidates and replaced providers; deleting an active registration is not a host-revocation mechanism.

## Let a coding agent add the source

Adding a source is mostly mechanical once the surface is known: probe the site, pick a driver, write a codec, declare
hosts, add tests. That is a good task to hand to a coding agent working in this repository, with you reviewing the
probe evidence and the diff. Keep the agent away from enablement and deployment; those are operator decisions.

```text
Add <source name and listing URL> to Jobseeker as a vacancy source. Read packages/sources/README.md and
src/vacancies/providers.ts first. Probe the public JSON or HTML surface and show the evidence, then pick the
closest reusable driver (or createSourceProvider directly). Keep the concrete provider under
src/vacancies/providers/, declare every host, fetch only through context.http, keep raw queries out of traces,
and add deterministic tests. Run typecheck, test, and build, then stop for approval before enabling or deploying.
```

## Choosing a reusable driver

| Source surface | Driver | Concrete definition supplies |
|---|---|---|
| Paginated JSON listing, optionally JSON detail | `createApiSource()` | Identity, schema/template, URL builders, listing codec, detail codec |
| Greenhouse, Lever, Ashby, or SmartRecruiters boards | `createAtsSource()` | Application identity and `provider:slug` customer boards |
| First-party JSON search with HTML detail pages | `createCompanySiteSource()` | Identity, query rules, listing codec, pagination, detail codec |
| Enumerated HTML listing with `JobPosting` detail pages | `createJsonLdBoardSource()` | Identity, listing URL, entry parser, hosts, query-language rules |
| Anything else | `createSourceProvider()` | Complete source-specific discovery and normalization |

Do not stretch a driver around an incompatible surface. Start with a direct application-owned provider and extract a
new generic mechanism only after multiple concrete sources demonstrate the same shape.

### JSON API driver

```ts
import { createApiSource } from '@jobseeker/sources/drivers/api';

export function exampleApiSource(options = {}) {
  return createApiSource({
    id: 'example-api',
    name: 'Example API Careers',
    hosts: ['api.example.com', 'careers.example.com'],
    schema: searchProfileSchema,
    template: validationTemplate,
    searchName: (search) => search.name,
    searchUrl: (search, cursor) => listingUrl(search.query, cursor),
    listingPage: (payload, search) => decodeListingPage(payload, search),
    detailUrl: (candidate) => detailUrl(candidate.sourceId), // optional
    vacancy: (candidate, payload, context) => decodeVacancy(
      candidate,
      payload,
      context.http.safeVacancyUrl,
    ),
  }, options);
}
```

The driver budgets pages across planned searches, records bounded candidates, follows codec-provided cursors, fetches
optional detail JSON, and isolates normalization failures per candidate. Ozon and RWB are application-owned examples.

### ATS driver

```ts
import { createAtsSource } from '@jobseeker/sources/drivers/ats';

export function companyBoardsSource(boards: readonly string[]) {
  return createAtsSource(
    { id: 'company-boards', name: 'Configured company boards' },
    { boards },
  );
}
```

Board entries use `provider:slug` syntax, for example `lever:example` or `greenhouse:example`. Customer slugs are
operator/application data and are never embedded in the package. The driver enumerates configured boards, title-matches
planned searches, normalizes complete board payloads, and fetches SmartRecruiters details only for matched postings.

### Company-site driver

`createCompanySiteSource()` is for first-party sites that expose a JSON listing/search surface but canonical HTML vacancy
pages. The concrete definition controls query language, pagination, listing decoding, canonical links, and HTML detail
normalization. Yandex is an application-owned example.

### JSON-LD board driver

`createJsonLdBoardSource()` enumerates server-rendered listing pages, uses an application-provided entry parser, matches
posting titles locally, and normalizes detail pages through schema.org `JobPosting`. Avito is an application-owned
example.

## Planning behavior

Providers can declare optional planning capabilities:

- `enumerates: true` means one whole-board enumeration can serve every search cluster;
- `mergeText: 'or'` means equivalent text demand may be combined into one OR query.

The provider schema validates generated search profiles, while `template()` tells the profile generator what the source
accepts. Source-specific query language and restrictions stay with the concrete provider, not in a package-wide map.

## Privacy and observability

A search query can be derived from private CV content. Concrete providers and drivers must not put raw queries,
rationales, or query-bearing URLs into traces. Trace source ID, page/cursor position, result counts, and bounded error
summaries instead. Candidate `sourceQuery` is internal matching provenance, not observability output.

## Application composition example

The root application currently composes fresh factories explicitly:

```ts
const providers = [
  browserBackedSource(browserOptions),
  publicApiSource({ maxPages: 1 }),
  companyCareerSource({ maxPages: 1 }),
  externalProvider(),
];

const sources = createSources(runtimeOptions);
for (const provider of providers) sources.setProvider(provider);
```

There is intentionally no `providers/all` export and no central union of valid source IDs. A provider becomes available
by registration; operator configuration independently decides whether it participates in discovery.

## Testing

Generic runtime and driver tests belong in this workspace. Tests tied to a concrete company, board, selector, browser,
or source ID belong in the root application's `tests/` directory.

```bash
bun test packages/sources
bun run typecheck
bun run test
bun run build
```

The repository's package-boundary tests prevent concrete provider catalogues, application environment access, root
imports, and browser dependencies from drifting back into `@jobseeker/sources`.
