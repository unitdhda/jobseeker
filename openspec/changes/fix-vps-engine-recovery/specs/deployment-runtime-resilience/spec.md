## Purpose

Ensures a continuously running deployment recovers from transient database and ownership failures while exposing truthful, secret-safe operational health.

## ADDED Requirements

### Requirement: Database disconnects are contained
The service SHALL contain transient PostgreSQL client disconnects without emitting unhandled process errors, and diagnostics MUST NOT include connection strings, credentials, or serialized database client internals.

#### Scenario: Connected client times out
- **WHEN** PostgreSQL reports a timeout or unexpected disconnect on a checked-out or singleton client
- **THEN** the affected operation or ownership lease fails through the managed service lifecycle without an unhandled client error
- **AND** emitted diagnostics identify the operation and safe error code only

### Requirement: Engine ownership recovers automatically
A deployment configured to run jobs SHALL keep attempting to acquire engine ownership after temporary contention and SHALL resume the engine once ownership becomes available.

#### Scenario: Stale lock outlives a crashed process
- **WHEN** startup cannot acquire the engine lock and the lock becomes available later
- **THEN** the same service process acquires ownership without an operator restart
- **AND** begins processing due work

#### Scenario: Ownership connection is lost
- **WHEN** the database connection carrying engine ownership fails
- **THEN** the service stops work associated with that lease
- **AND** retries ownership using bounded backoff
- **AND** never runs two local engine loops concurrently

### Requirement: Readiness reflects required engine ownership
When job execution is enabled, readiness SHALL report unavailable while the process does not own a live engine lease; liveness SHALL remain available while the process can continue recovery attempts.

#### Scenario: HTTP service is alive but engine is waiting
- **WHEN** the web service and database are reachable but required engine ownership is absent
- **THEN** the liveness endpoint reports success
- **AND** the readiness endpoint reports failure

#### Scenario: Engine recovers
- **WHEN** the process acquires a live engine lease and its loop is running
- **THEN** readiness reports success

### Requirement: Operators can distinguish active and waiting engines
Operational status SHALL distinguish an actively running engine from one waiting for ownership or recovering from database failure.

#### Scenario: Status requested during lock contention
- **WHEN** an operator requests runtime status while the engine is waiting for ownership
- **THEN** the response identifies the waiting state rather than reporting a generic idle state
