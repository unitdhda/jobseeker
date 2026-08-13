# Assignment 03 — sources runtime, examples, and extensions

## Scope

Build an open, instance-scoped vacancy-provider runtime. The package owns contracts, security policy, parsing helpers, and reusable drivers. It does not own concrete employers, PostgreSQL, browsers, environment variables, or a global provider registry.

## File listing

```text
packages/sources/src/
├── contract.ts
├── context.ts
├── sources.ts
├── http.ts
├── boards.ts
├── companies.ts
├── drivers/{api,ats,company-site,jsonld-board}.ts
└── index.ts
packages/sources/examples/
extensions/{extension-api.ts,hh/,claude-cli/}
```

## 1. Public contracts

Define:

```ts
interface UserSearches<T> { userId: string; searches: readonly T[] }
interface PlanOptions { enumerates?: boolean; mergeText?: 'or' }
interface PlatformValidationTemplate {
  platform: string; version: number; purpose: string; jsonShape: unknown;
  capabilities: Record<string, unknown>; rules: string[];
}
interface SearchPlatform<S extends BaseSchema> {
  id: string; name: string; schema: S; template(): PlatformValidationTemplate;
  hosts: readonly string[]; enumerates?: boolean; mergeText?: 'or';
}
interface PlatformDiscoveryResult {
  searches: number; users: number; seen: number; discovered: number;
  discoveredBySearch?: Record<string,number>;
}
interface VacancyPlatform<S extends BaseSchema> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput|null|Error>>;
}
```

Define provider/runtime variants where `SourceContext` is passed explicitly to `discover`, `normalize`, and optional `close`.

## 2. Source context

```ts
interface SourceLimits {
  searchNewVacancyLimit: number;
  searchPageBudgetPerPlatform: number;
}
interface SourcesOptions {
  limits: SourceLimits;
  trace(event: string, data?: unknown): void;
  errorMessage(error: unknown): string;
  recordListingCandidate(input: VacancyCandidateInput): Promise<boolean>;
}
interface SourceContext extends SourcesOptions { readonly http: SourceHttp }
```

No ambient async context or global mutable source state is allowed.

## 3. Provider factory and collection

`createSourceProvider` must snapshot/deduplicate/freeze hosts and reject a normalization batch containing another source ID.

`createSources(options)` starts empty and returns a mutable collection with:

- immutable current URL policy;
- registration-order `platformIds` snapshot;
- `getProviders`, `getProvider`, `getPlatform`;
- `setProvider` replacement by ID;
- `deleteProvider`, `clearProviders`;
- schema-validated `platformSearches`;
- source-routed normalization;
- idempotent `close` of every provider ever owned, including replaced/deleted providers.

Requirements:

- two collections with the same IDs remain independent;
- providers become runtime-bound only when retrieved as platforms;
- host policy retains every provider the collection has owned;
- mutation after close is rejected;
- one or multiple close errors propagate.

## 4. URL/HTTP security boundary

Define `SourceUrlPolicy` and `SourceHttp`.

### URL checks

For each provider:

- URL must parse;
- protocol is HTTPS;
- no username/password;
- no explicit port;
- hostname is exactly declared for that source.

### DNS/IP checks

Before each network request:

- reject IP literals;
- resolve all addresses;
- require all destinations to be public unicast;
- reject loopback, private, carrier-grade NAT, link-local, unspecified, multicast, and mapped private IPv4.

### Request checks

- manual redirects only;
- at most three redirects;
- revalidate every redirect;
- block cross-origin redirects;
- enforce both declared content length and streamed byte count;
- default maximum 5 MiB;
- validate JSON/HTML content types;
- source user agent `JobseekerVacancyMonitor/1.0`;
- source helpers are the only allowed remote fetch path.

### Parsing helpers

Implement:

- `asObject`, `plainText`, `htmlText`;
- Russian printed dates with previous-year rollover;
- JSON-LD `JobPosting` extraction, including `@graph`;
- salary text and structured salary normalization;
- structured location;
- `structuredVacancy` and `hashedVacancy`;
- `VacancySearchCollector`.

Collector semantics:

- unique by `(source,sourceId)` across a whole plan;
- stop after globally new vacancy limit;
- one shared listing write, regardless of recipients;
- preserve one internal search name;
- return seen/discovered and discovered-by-search counts.

Raw queries, rationale, and query-bearing URLs must not enter traces.

## 5. Generic drivers

### Paginated JSON API

Define `ApiListing`, `ApiListingPage`, `ApiSourceDefinition`, and `ApiSourceOptions`.

Driver responsibilities:

1. divide page budget across planned searches;
2. build listing requests with default JSON accept/user-agent/timeout;
3. follow codec cursor up to max pages;
4. persist bounded listings;
5. optionally fetch JSON detail;
6. normalize each candidate independently to vacancy/null/error;
7. preserve custom request headers/options.

### Grouped ATS

Support Greenhouse, Lever, Ashby, and SmartRecruiters.

- Configuration uses `provider:slug` entries.
- Reject malformed/unknown providers.
- Enumerate boards and match all significant query words against posting title.
- Normalize product-specific payloads.
- Use canonical public URLs within declared hosts.
- Fetch SmartRecruiters detail only for matched postings.
- No customer slug catalogue in the package.

### Company-site

Define `CompanyListing`, `CompanyListingPage`, and `CompanySite`.

- JSON listing/search, canonical HTML detail.
- Concrete definition owns query language, URL builders, codecs, employer, hosts, and rules.
- Generic detail extraction reads `<h1>` and `<main>` where suitable.
- Normalize with safe URL and deterministic hash.

### JSON-LD board

Define `BoardEntry` and `JsonLdBoard`.

- Enumerate board pages.
- Match title locally.
- Use real listing title/date.
- Normalize schema.org detail.
- Mark platform `enumerates: true`.

Do not force an incompatible source into a driver; direct `createSourceProvider` is valid.

## 6. Example provider catalogue

Examples are source files copied into a deployment, never imported by app runtime.

Implement these 19 examples:

| ID | Surface |
|---|---|
| `habr` | HTML search cards + JobPosting detail |
| `rabota` | SEO listing JSON-LD |
| `hirehi` | constrained SEO specialization/facet pages |
| `geekjob` | enumerated listing + JSON-LD detail |
| `avito` | enumerated listing + JSON-LD detail |
| `trudvsem` | federal open JSON API, complete payload |
| `ats` | configured grouped ATS boards |
| `yandex` | JSON search + HTML detail |
| `ozon` | paginated listing/detail JSON APIs |
| `rwb` | paginated listing/detail JSON APIs |
| `mts` | catalog/detail JSON APIs |
| `vk` | JSON listing + itemprop HTML detail |
| `kontur` | single enumerated JSON-LD board |
| `magnit` | paginated JSON listing/detail |
| `yadro` | complete JSON listings |
| `selectel` | enumerated JSON catalogue + detail |
| `sber` | complete paginated JSON/Markdown listings |
| `kaspersky` | server-rendered search + RSC metadata |
| `tbank` | RPC enumeration + SSR state detail |

Each provider must:

- return a fresh instance;
- have a unique ID and closed host list;
- expose a strict profile schema and template that states every search count limit;
- produce canonical URL, title, publication date when available, normalized fields, and content hash;
- distinguish closed/unusable (`null`) from parser failure (`Error`);
- default-export `register(api)`.

### Copied-example toolkit

Because internal workspace packages are bundled and not published, copied examples must receive runtime values through `toolkit.ts`. Workspace imports in examples may only be type-only and erased.

The copied directory can be used in one of two ways:

1. copy the whole folder; loader sees `index.ts`, which registers all;
2. copy selected provider files with shared helpers but without `index.ts`.

Never combine both, or duplicate IDs must fail startup.

## 7. Application extension API

Define `JobseekerExtensionApi` with:

```ts
registerSourceProvider(provider): void
registerAiProvider(provider): void
onStartup(hook): void
onShutdown(hook): void
readonly env: Readonly<Record<string,string|undefined>>
log(message): void
readonly sources: sources toolkit + drivers
readonly concurrency: { AdaptiveTaskPool; mapConcurrent }
readonly state: { configured; get; put; delete }
```

Loader behavior:

- root defaults to `./extensions`, override by `JOBSEEKER_EXTENSIONS`;
- load top-level `.ts/.mts/.mjs/.js` files and subdirectory `index.*`;
- ignore dotfiles, declarations, node_modules, unrelated files;
- deterministic name order;
- every discovered module must default-export a register function;
- missing directory means empty composition;
- memoize process-wide load;
- duplicate provider IDs fail composition;
- `SEARCH_PLATFORMS` narrows discovery but all registered providers remain available for normalization and URL policy.

## 8. HH browser extension

Implement HH outside the workspace.

### Profile

Strict profile supports Russian search text and bounded HH filters (areas required, fields, metro, role/industry/employer IDs, experience, employment, schedules, hours, work format, education, licenses, labels, optional salary, period 1–30 days, ordering). Maximum searches: 8. `mergeText='or'`.

### Browser runtime

- one `AdaptiveTaskPool(1,1)`;
- one persistent Chromium context;
- sandbox enabled;
- block image/media/font resources;
- explicit locale/timezone/environment;
- retry context launch;
- bounded context close;
- per-operation timeout;
- reset crashed/closed context;
- never add browser parallelism as a timeout fix.

### Discovery/normalization

- validate URL and DNS before browser navigation;
- classify captcha explicitly;
- search cards produce IDs/titles;
- page age is bounded through HH period filter;
- each normalization candidate gets its own deadline;
- detect closed/archive markers before and after title wait;
- parse fields by stable data attributes;
- read publication date from JobPosting, then visible Russian text, otherwise log and use read time;
- canonicalize to `https://hh.ru/vacancy/<id>`.

### Browser-state persistence

When encrypted state is configured:

- archive `hh-browser` only;
- exclude caches/crash telemetry;
- enforce 180 MiB archive cap;
- validate tar paths before extraction;
- stage and atomically rename beside destination;
- use object path `browser/hh.tar.gz`.

## 9. Claude CLI AI extension

Implement a Pi-AI provider called `claude-cli`:

- model catalogue and estimated costs;
- flatten single/multi-turn text contexts;
- spawn local CLI or POST to a sidecar;
- replace default system prompt and disable CLI tools;
- map thinking levels to effort;
- optional JSON schema;
- parse stream-json NDJSON into thinking/text events;
- preserve usage and authoritative CLI total cost;
- handle abort, timeout, missing executable, non-zero exit, and missing result.

Sidecar requirements:

- bearer token with timing-safe comparison;
- loopback/private deployment only;
- request/body/concurrency/time limits;
- allowlist CLI flags;
- stream NDJSON;
- kill CLI when client disconnects;
- support static setup token or refreshable OAuth file with atomic rotated-token persistence;
- `/health` reveals only status/expiry metadata.

## Acceptance tests

Run:

```bash
bun test packages/sources
bun test extensions/hh extensions/claude-cli
bun run typecheck
```

Tests must cover:

- explicit context and independent collections;
- replacement/deletion/close lifecycle;
- URL allowlists, unsafe URLs, public-IP classification, response bounds;
- API pagination/detail and custom headers;
- ATS and JSON-LD driver openness;
- all concrete codecs and canonical URLs;
- real listing dates/titles and closed-page behavior;
- search-template/schema cap parity;
- copied examples loading under Node outside the monorepo with only `valibot` installed;
- HH independent factories and publication-date fallback;
- Claude bridge args, streaming, usage, errors, remote auth, and forbidden flags.
