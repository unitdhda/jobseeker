## Why

A process crash can leave vacancy candidates permanently trapped in `normalizing`, while repeated partial discovery failures keep every search unit overdue and expose no actionable diagnostics. Production currently has 440 abandoned normalization claims and 447 overdue units, so the pipeline needs bounded claims, fair incremental processing, and visible provider outcomes.

## What Changes

- Make normalization claims expire and become reclaimable without adding a database column.
- Select normalization work fairly across sources so a large HH backlog cannot starve other providers.
- Persist each candidate outcome incrementally so later source timeouts do not discard earlier successful parsing.
- Expose per-platform discovery success/failure and normalization queue/claim health in operator status and safe logs.
- Add a controlled production recovery procedure for abandoned claims rather than releasing the full backlog at once.
- Release the correction as `0.2.9` and verify completed search-unit cadence and normalization throughput after deployment.

## Capabilities

### New Capabilities
- `normalization-pipeline-resilience`: Defines expiring claims, fair incremental parsing, partial-result durability, and observable source outcomes for vacancy ingestion.

### Modified Capabilities

None.

## Impact

- Scheduler reports in `packages/engine`.
- Candidate claiming and lifecycle transitions in `packages/store`.
- Normalization adapters, runtime status, and logging in `packages/app`.
- HH and generic source invocation behavior without changing provider contracts.
- Fresh database schema semantics for `next_normalization_at`; no schema migration or new column.
- Production recovery SQL, package release pins, and VPS redeployment checks.
