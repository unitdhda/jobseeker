## Why

A process crash can leave vacancy candidates permanently trapped in `normalizing`, while repeated partial discovery failures keep every search unit overdue and expose no actionable diagnostics. Production currently has 440 abandoned normalization claims and 447 overdue units, so the pipeline needs bounded claims, fair incremental processing, and visible provider outcomes.

Deploying the first correction revealed two further defects that keep the pipeline stalled and were invisible because their failures are swallowed. Every cadence write fails with PostgreSQL `42P08` because one query parameter is deduced as both an integer column value and an interval multiplier, so no search unit has ever advanced. One legacy stored row without a listing hash aborts candidate selection after queue claims have already committed, so reclaimed candidates churn without ever being parsed.

## What Changes

- Make normalization claims expire and become reclaimable without adding a database column.
- Select normalization work fairly across sources so a large HH backlog cannot starve other providers.
- Persist each candidate outcome incrementally so later source timeouts do not discard earlier successful parsing.
- Expose per-platform discovery success/failure and normalization queue/claim health in operator status and safe logs.
- Add a controlled production recovery procedure for abandoned claims rather than releasing the full backlog at once.
- Release the correction as `0.2.9` and verify completed search-unit cadence and normalization throughput after deployment.
- Make parameterized interval arithmetic explicitly typed so recording a completed search-unit run cannot fail on parameter type deduction.
- Exclude stored rows that cannot be decoded from candidate selection, count them, and keep claimed queue work processable when refresh selection fails.
- Report cadence-write and normalization stage failures instead of discarding them silently.
- Repair the PostgreSQL integration runner and cover scheduling, claiming, and malformed-row behaviour against a real database.
- Release the combined correction as `0.2.10`.

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
- Search-unit scheduling writes and interval arithmetic in `packages/store`.
- The PostgreSQL integration runner in the repository scripts and `packages/app` tests.
- Production recovery SQL, package release pins, and VPS redeployment checks.
