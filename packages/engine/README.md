# @jobseeker/engine

The pure algorithms of the discovery engine. No IO, no storage, no `process.env` — every function is
deterministic over its arguments, which is why the migration and the scheduler can share them and never disagree.

| Module | What it decides |
|---|---|
| `canon.ts` | Canonical role tokens for a search: cross-language, grade words dropped |
| `identity.ts` | Content-addressed unit identity (`unitIdentityOf`) and token similarity |
| `subscribe.ts` | `compileDemand`: raw per-user searches → units + subscriptions, with adopt-at-compile-time — units never re-cluster later |
| `cadence.ts` | `nextCadence`: novelty halves the interval toward the floor, silence stretches it toward the ceiling |
| `pick.ts` | `pickDueUnits`: which due units run under a budget — every subscriber served before spare budget buys breadth |
| `match-state.ts` | The match lifecycle as a checked transition table; `deliveredStates` names what may never be re-delivered |

Consumed by the app's runtime (`src/engine-runtime.ts`, `src/engine-loop.ts`), by `@jobseeker/store` (transition
enforcement), and by the cutover migration (`src/scripts/migration/`), which compiled production demand with this
exact code.

```bash
bun test packages/engine
```
