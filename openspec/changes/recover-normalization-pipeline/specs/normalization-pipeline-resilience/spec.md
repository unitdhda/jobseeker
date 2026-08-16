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

### Requirement: Completed search-unit runs advance cadence durably
Recording a completed search-unit run SHALL durably advance that unit's cadence and next run time, and a scheduling write that fails SHALL be counted and reported rather than discarded silently.

#### Scenario: Provider completes discovery for a selected unit
- **WHEN** a provider completes discovery and the unit's run is recorded
- **THEN** the unit's next run time moves into the future
- **AND** the unit is no longer due in the following cycle

#### Scenario: Scheduling write fails
- **WHEN** recording a completed run fails
- **THEN** the unit remains due
- **AND** operator diagnostics report the count of failed scheduling writes

### Requirement: Undecodable stored rows cannot stall the pipeline
Candidate selection SHALL exclude stored rows it cannot decode, report how many are excluded, and continue processing the remaining candidates.

#### Scenario: Stored row lacks a decodable listing identity
- **WHEN** a stored row that cannot be decoded becomes due for normalization or refresh
- **THEN** selection excludes that row instead of claiming it
- **AND** the remaining due candidates are processed in the same cycle

#### Scenario: Refresh selection fails after queue claims commit
- **WHEN** refresh selection fails in a cycle that already claimed queue candidates
- **THEN** those claimed candidates are still processed and persisted in that cycle
- **AND** the selection failure is reported

### Requirement: Pipeline health is observable
Operator diagnostics SHALL expose failed discovery provider identities, successful/failed unit counts, failed scheduling writes, due search units, queued candidates, active claims, expired claims, and excluded undecodable rows without exposing queries, vacancy content, credentials, or connection details.

#### Scenario: Provider partially writes then fails
- **WHEN** a provider records listings but fails before completing discovery
- **THEN** safe diagnostics identify the provider as failed
- **AND** do not represent partial writes as a successful completed search

#### Scenario: Abandoned claims accumulate
- **WHEN** expired normalization claims exist
- **THEN** operator status reports their count separately from active claims and ordinary queued work

#### Scenario: Discovery completes without advancing any unit
- **WHEN** providers complete but no unit run is recorded successfully
- **THEN** safe logs report the advanced-unit count and the failed scheduling-write count
- **AND** do not present the cycle as fully successful
