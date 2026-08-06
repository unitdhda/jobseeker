# @jobseeker/sources

The vacancy-platform contract and all eight adapters: HH, Habr Career, Работа.ру, HireHi, GeekJob, Avito,
Работа России, and company ATS boards.

- `contract.ts` — what a platform is: `discover(plan)` over shared search plans with per-recipient search names,
  normalization of queued listings, profile schemas and validation templates. Discovery results carry
  `discoveredBySearch`, so novelty is attributed to the search that earned it, not the whole platform.
- `http.ts` — fetch guards and the shared collector; candidate persistence is an injected port, so the package has
  no PostgreSQL dependency.
- `http.ts` + per-platform `hosts` declarations — every outbound URL is checked against the platform's declared
  hosts before fetching; redirects are re-checked.
- `hh.ts` — the one browser-backed adapter (Playwright); its operations are serialized platform-wide.
- `@jobseeker/engine/concurrency` — adaptive pools shared with the application, backed by `p-limit`.
- `ipaddr.js` — public/private IP classification inside the package's stricter host and redirect policy.

The package never reads `process.env`. `createSourceRegistry` receives page budgets, timeouts, board lists, the
Chromium child environment, observability, and candidate-persistence ports. Each registry owns its HH browser and
pools; adapters stay inert until a plan reaches them.

```bash
bun test packages/sources
```
