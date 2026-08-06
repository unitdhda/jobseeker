# @jobseeker/engine

The policy and port-driven runtime of the discovery engine. It has no storage, network implementation, or
`process.env`; algorithms are deterministic over arguments and runtime IO is supplied through explicit ports.

| Module | What it decides |
|---|---|
| `contracts.ts` | Shared search-plan, listing, and normalized-vacancy contracts owned by the pipeline |
| `concurrency.ts` | Adaptive and keyed execution policy over `p-limit` |
| `canon.ts` | Canonical role tokens for a search: cross-language, grade words dropped |
| `identity.ts` | Content-addressed unit identity (`unitIdentityOf`) and token similarity |
| `subscribe.ts` | `compileDemand`: raw per-user searches → units + subscriptions, with adopt-at-compile-time — units never re-cluster later |
| `cadence.ts` | `nextCadence`: novelty halves the interval toward the floor, silence stretches it toward the ceiling |
| `pick.ts` | `pickDueUnits`: which due units run under a budget — every subscriber served before spare budget buys breadth |
| `match-state.ts` | The match lifecycle as a checked transition table; `deliveredStates` names what may never be re-delivered |
| `prefilter.ts` | CV-derived lexical matching, career-profile validation, and advert-age policy |
| `runtime.ts` | Port-driven discovery ticks and match-on-ingest orchestration |
| `loop.ts` | Independent discovery/judgment lanes and paced per-user scoring budgets |

Consumed by the app composition (`src/engine-main.ts`), by `@jobseeker/store` for transition enforcement, and by
the cutover migration (`src/scripts/migration/`), which compiled production demand with this exact code.

```bash
bun test packages/engine
```
