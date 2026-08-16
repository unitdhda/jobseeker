## Purpose

Ensures vacancy discovery and parsing recover from interrupted work, preserve partial progress, share capacity across sources, and expose actionable provider outcomes.

## ADDED Requirements

### Requirement: Normalization claims expire
Every normalization claim SHALL have a bounded lease, and an unfinished candidate SHALL become eligible for reclaim after that lease expires.

#### Scenario: Process exits during normalization
- **WHEN** a process claims a candidate and exits before recording an outcome
- **THEN** the candidate remains unavailable to another claimant until its lease expires
- **AND** becomes eligible for a later normalization cycle after expiry

#### Scenario: Active claim has not expired
- **WHEN** another normalization cycle runs before a candidate's claim lease expires
- **THEN** that cycle does not claim the candidate

### Requirement: Normalization capacity is fair across sources
A normalization cycle SHALL bound work from each source so one source backlog cannot consume all available capacity while another source has due candidates.

#### Scenario: Large and small source backlogs coexist
- **WHEN** one source has more due candidates than the per-source allowance and another source has due candidates
- **THEN** the cycle claims candidates from both sources within the global limit

### Requirement: Candidate outcomes are durable incrementally
The system SHALL record each candidate's normalized, duplicate, closed, or failed outcome without waiting for every candidate from that source to finish.

#### Scenario: Later candidate times out
- **WHEN** an earlier candidate normalizes successfully and a later candidate from the same source times out
- **THEN** the earlier candidate remains durably normalized
- **AND** the later candidate receives its own failed outcome and retry schedule

#### Scenario: Process exits between candidates
- **WHEN** a process exits after persisting some candidate outcomes in a claimed batch
- **THEN** those completed outcomes remain final
- **AND** only unfinished claims require lease-based recovery

### Requirement: Provider failures preserve scheduling semantics
A failed discovery provider SHALL leave affected search units due for retry, while successful providers SHALL advance their own units independently.

#### Scenario: Mixed provider outcomes
- **WHEN** one provider fails and another provider completes in the same discovery cycle
- **THEN** the failed provider's selected units remain due
- **AND** the successful provider's completed units advance cadence

### Requirement: Pipeline health is observable
Operator diagnostics SHALL expose failed discovery provider identities, successful/failed unit counts, due search units, queued candidates, active claims, and expired claims without exposing queries, vacancy content, credentials, or connection details.

#### Scenario: Provider partially writes then fails
- **WHEN** a provider records listings but fails before completing discovery
- **THEN** safe diagnostics identify the provider as failed
- **AND** do not represent partial writes as a successful completed search

#### Scenario: Abandoned claims accumulate
- **WHEN** expired normalization claims exist
- **THEN** operator status reports their count separately from active claims and ordinary queued work
