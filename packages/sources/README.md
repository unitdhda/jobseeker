# @jobseeker/sources

The vacancy-platform contract and adapters for HH, Habr Career, Работа.ру, HireHi, GeekJob, Avito,
Работа России, company ATS boards, and first-party company career sites such as Yandex Careers.

- `contract.ts` — what a platform is: `discover(plan)` over shared search plans with per-recipient search names,
  normalization of queued listings, profile schemas and validation templates. Discovery results carry
  `discoveredBySearch`, so novelty is attributed to the search that earned it, not the whole platform.
- `http.ts` — fetch guards and the shared collector; candidate persistence is an injected port, so the package has
  no PostgreSQL dependency.
- `http.ts` + per-platform `hosts` declarations — every outbound URL is checked against the platform's declared
  hosts before fetching; redirects are re-checked.
- `companies.ts` — a data-driven first-party career-site runner. Each company definition supplies only its hosts,
  search-page codec, and detail-page codec; profile validation, budgets, collection, observability, and SSRF checks
  stay shared. Yandex is the first definition and uses its public search API plus server-rendered detail pages.
- `hh.ts` — the one browser-backed adapter (Playwright); its operations are serialized platform-wide.
- `@jobseeker/engine/concurrency` — adaptive pools shared with the application, backed by `p-limit`.
- `ipaddr.js` — public/private IP classification inside the package's stricter host and redirect policy.

The package never reads `process.env`. `createSourceRegistry` receives page budgets, timeouts, board lists, the
Chromium child environment, observability, and candidate-persistence ports. Each registry owns its HH browser and
pools; adapters stay inert until a plan reaches them. Adapter identity is owned and validated by this registry;
PostgreSQL stores source and platform IDs as text without duplicating the registry as an enum-style allowlist.

```bash
bun test packages/sources
```
