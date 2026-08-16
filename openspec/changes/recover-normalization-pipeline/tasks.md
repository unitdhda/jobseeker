## 1. Lease-Aware Fair Claims

- [x] 1.1 Extend normalization configuration and repository contracts with bounded claim lease and per-source limits
- [x] 1.2 Implement deterministic source-ranked claiming for due queued rows and expired `normalizing` rows using `next_normalization_at`
- [x] 1.3 Add repository tests for active lease exclusion, expired claim recovery, source fairness, global limits, attempts, and retry deadlines
- [x] 1.4 Document lifecycle-dependent `next_normalization_at` invariants in the fresh schema and repository policy tests

## 2. Incremental Normalization

- [x] 2.1 Process candidates sequentially within each source while retaining bounded concurrency across sources
- [x] 2.2 Persist normalized, duplicate, closed, and failed outcomes immediately after each single-candidate provider result
- [x] 2.3 Add adapter tests proving earlier outcomes survive later timeout, omission, exception, and simulated process-boundary cases

## 3. Discovery and Queue Observability

- [x] 3.1 Extend scheduler tick reports with stable successful and failed platform identities and per-platform unit outcomes
- [x] 3.2 Retain latest discovery outcomes in engine status and safely log aggregate provider transitions
- [x] 3.3 Extend scraper/runtime summaries with due units, queued candidates, active claims, expired claims, and failed provider identities
- [x] 3.4 Add engine, store, web/status, localization, and secret-safety tests for the new diagnostics

## 4. Release Preparation

- [x] 4.1 Run focused tests, full tests, typecheck, build, package smoke, strict OpenSpec validation, and secret review
- [x] 4.2 Bump application, reference deployment, documentation, and packaging assertions from `0.2.8` to `0.2.9`
- [x] 4.3 Commit and push the completed change, then pause for publication of `@unitdhda/jobseeker@0.2.9`

## 5. Controlled Production Recovery

- [x] 5.1 Verify publication, back up PostgreSQL plus VPS assets, and record baseline source/queue/claim counts
- [x] 5.2 If needed before cutover, reset only 10 abandoned HH and all 6 Trudvsem claims as an immediate canary and verify durable outcomes
- [x] 5.3 Build the published candidate, run `doctor`, deploy `0.2.9`, and verify health, readiness, one engine lock, zero restart churn, and safe logs
- [ ] 5.4 Verify successful provider cadence advancement and bounded decline of queued/expired claims before allowing automatic backlog drainage

## 6. Scheduling and Decoding Durability

- [x] 6.1 Give every parameterized interval an explicit type so recording a completed unit run cannot fail on parameter type deduction
- [x] 6.2 Exclude undecodable stored rows from queue and refresh selection and report the excluded count in operator diagnostics
- [x] 6.3 Claim queue candidates independently of refresh selection so a refresh failure cannot discard claimed work
- [x] 6.4 Report advanced units, failed scheduling writes, and normalization stage outcomes in safe logs and engine status
- [x] 6.5 Add source-level policy tests forbidding untyped parameter interval arithmetic and covering the new selection predicates
- [x] 6.6 Repair the PostgreSQL integration runner and cover cadence advancement, claim leases, source fairness, and undecodable-row exclusion against a real database

## 7. Combined Release

- [x] 7.1 Run focused tests, full tests, typecheck, build, package smoke, real-database tests, strict OpenSpec validation, and secret review
- [x] 7.2 Bump application, reference deployment, documentation, and packaging assertions from `0.2.9` to `0.2.10`
- [x] 7.3 Commit and push the completed change, then pause for publication of `@unitdhda/jobseeker@0.2.10`
- [ ] 7.4 Deploy `0.2.10`, verify health, readiness, one engine lock, zero restart churn, and safe logs, then confirm advancing units and declining expired claims
