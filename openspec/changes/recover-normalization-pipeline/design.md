## Context

The discovery lane runs scheduler tick, normalization, and matching sequentially. Provider discovery is concurrent across a bounded number of sources, but each provider completes as one operation; partial listing writes can precede a provider failure. Failed provider units intentionally remain due.

Normalization currently claims rows by changing `discovered` or `failed` to `normalizing`. There is no lease expiry, so a process exit leaves those rows permanently excluded. The production database has 434 HH and 6 Trudvsem rows in that state. Candidate groups are passed to a source as one batch and persisted only after the complete source call returns. HH processes its group serially, making a large group both slow and vulnerable to losing all in-memory results after a timeout.

The repository has a single fresh-schema definition and no migration runner. The existing `next_normalization_at` field is not changed by rediscovery and can carry claim expiry semantics without adding a column.

## Goals / Non-Goals

**Goals:**
- Recover abandoned normalization work automatically.
- Guarantee source-fair claims within each global cycle budget.
- Make each completed parse durable before starting the next candidate for that source.
- Preserve independent provider scheduling outcomes.
- Give operators safe evidence of where discovery and normalization are blocked.

**Non-Goals:**
- Make all external vacancy providers reliable.
- Advance cadence after provider failure.
- Parallelize HH browser operations within one persistent profile.
- Add a schema migration framework or new database column.
- Automatically release the entire production backlog in one cycle.

## Decisions

### Reuse `next_normalization_at` as the claim lease deadline

Claiming a row sets `lifecycle_status='normalizing'`, increments attempts, and sets `next_normalization_at` to the bounded lease deadline. Claim selection includes ordinary due `discovered`/`failed` rows and `normalizing` rows whose deadline expired. Terminal successful/closed states ignore the field; failures replace it with their normal retry deadline.

This is safe because rediscovery updates listing metadata and `updated_at` but does not modify `next_normalization_at`. Using `updated_at` was rejected because partial discovery continually refreshes abandoned rows and could postpone recovery forever. A new claim column was rejected because production has no migration runner.

### Claim with a global limit and explicit per-source limit

The store claim API will accept both limits. SQL ranks eligible rows within each source, filters to the per-source allowance, then applies deterministic global ordering and `FOR UPDATE SKIP LOCKED`. The application will derive the global budget from CV-bearing approved users as today and use a small configured per-source bound.

Pure round-robin without a source cap was rejected because once small sources are exhausted, one large source can still create an unsafe serial batch.

### Invoke normalization one candidate at a time per source

The adapter will retain bounded concurrency across different sources but call the existing provider contract with a single candidate and persist that outcome before continuing to the next candidate for that source. This preserves provider isolation and HH serialization while ensuring partial progress is durable.

Changing the provider contract to a streaming API was rejected as unnecessary churn across every extension and copied example.

### Report provider identities in scheduler results

Scheduler reports will include stable successful and failed platform identifiers plus unit counts. Provider exceptions remain sanitized at the application boundary; no query payload or raw external response enters status. The engine loop retains the latest report, and `/scraper`/runtime diagnostics show provider failures and normalization queue health. Safe server logs emit state transitions and aggregate identifiers/counts only.

A count-only report was rejected because it cannot tell an operator which provider is preventing cadence advancement.

### Give every parameterized interval its own explicit type

Recording a completed unit run assigns `cadence_minutes=$2` and also computes `$2*interval '1 minute'`. PostgreSQL deduces `integer` from the assignment and `double precision` from the multiplication, rejects the statement with `42P08`, and the scheduler counts that as an isolated unit-update failure. Because the failure is per unit and silent, cadence never advances and every unit stays permanently due.

Every parameter used in interval arithmetic will carry an explicit type at each site: minute and day intervals use `make_interval`, and millisecond intervals cast the parameter directly. A source-level policy test will forbid multiplying a bare parameter by an interval literal, and a real-database test will assert that a recorded run moves `next_run_at` into the future.

Adding a second parameter for the same value was rejected because it leaves the untyped multiplication pattern available elsewhere in the repository.

### Exclude undecodable rows during selection rather than after claiming

One legacy `normalized` row has no listing hash, so decoding it throws. Because candidate decoding happens after the claim transaction commits, the whole normalization stage aborts while the claimed rows stay `normalizing` until their lease expires.

Queue and refresh selection will require a decodable stored shape in SQL, so poison rows are never claimed, and operator diagnostics will report how many stored rows are excluded. Skipping rows only after claiming was rejected because a claimed undecodable row would be reclaimed on every later cycle.

### Keep claimed queue work independent of refresh selection

Queue claiming and refresh selection currently run in one `Promise.all`, so a refresh failure discards already-claimed queue candidates. Claiming will run first, refresh selection failure will be counted and reported, and the cycle will continue with the candidates it already owns.

### Recover production in bounded stages

After deploying `0.2.9`, the automatic lease query can technically reclaim all 440 old rows, but per-source limits ensure only a bounded subset is selected per cycle. Before deployment, a small canary recovery may reset 10 HH rows and all 6 Trudvsem rows to `failed` with immediate due time only after taking a database backup. Remaining rows are left for the fixed lease mechanism.

## Risks / Trade-offs

- [Reusing a scheduling field adds lifecycle-dependent meaning] → Centralize predicates and document invariants in schema comments and repository tests.
- [A lease expires while an unusually slow candidate is still active] → Choose a lease longer than one candidate timeout and retain singleton engine ownership plus row transition predicates.
- [Single-candidate provider calls add setup overhead] → Providers retain their runtime/browser; only the normalization invocation and persistence boundary become smaller.
- [Persistent provider failures keep units overdue] → Preserve correctness, expose provider identity, and let operators disable or repair that provider rather than silently skipping searches.
- [The old backlog causes sustained load] → Enforce per-source/global limits and verify throughput before increasing them.

## Migration Plan

1. Back up production PostgreSQL and deployment assets; record baseline queue/source counts.
2. Optionally recover a canary of 10 HH and 6 Trudvsem abandoned rows and verify behavior without touching the remaining claims.
3. Implement lease-aware fair claiming, incremental persistence, scheduler outcomes, and diagnostics with deterministic tests.
4. Bump package and deployment pins to `0.2.9`; run typecheck, full tests, build, package smoke, and strict OpenSpec validation.
5. Publish and deploy `0.2.9`, then verify one engine lock, zero restarts, successful provider cadence advancement, decreasing expired claims, and durable candidate outcomes.
6. Allow the fixed claim mechanism to drain the remaining production backlog under bounded limits.

7. Correct the cadence write, candidate selection, stage isolation, and diagnostics; release `0.2.10`; and verify that units advance and expired claims decline.

Rollback restores the previous published version only after ensuring no actively reclaimed rows are left in a state that the old runtime cannot process. No DDL rollback is required.
