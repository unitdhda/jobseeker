# @jobseeker/sources

The vacancy-platform contract and all eight adapters: HH, Habr Career, Работа.ру, HireHi, GeekJob, Avito,
Работа России, and company ATS boards.

- `contract.ts` — what a platform is: `discover(plan)` over shared search plans with per-recipient search names,
  normalization of queued listings, profile schemas and validation templates. Discovery results carry
  `discoveredBySearch`, so novelty is attributed to the search that earned it, not the whole platform.
- `http.ts` — the shared collector: fetch guards, listing recording (shared rows only — who sees a listing is
  the engine's decision, not the scraper's), per-search novelty counting.
- `ssrf.ts` + per-platform `hosts` declarations — every outbound URL is checked against the platform's declared
  hosts before fetching; redirects re-checked.
- `hh/` — the one browser-backed adapter (Playwright); its operations are serialized platform-wide.
- `concurrency.ts` — the adaptive pools the adapters share.

The package never reads `process.env`: the app calls `configureSources` once with settings (page budgets,
timeouts, board lists) and injected `trace`/`errorMessage`. Adapters stay inert until a plan reaches them.

```bash
bun test packages/sources
```
