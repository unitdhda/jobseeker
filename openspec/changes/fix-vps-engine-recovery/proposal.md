## Why

A transient PostgreSQL disconnect crashes the service, can leave the engine advisory lock temporarily retained by the database pooler, and causes the restarted process to remain idle indefinitely while health checks still pass. Production has accumulated hundreds of overdue search units, so the runtime must recover automatically and expose engine failure rather than presenting a false healthy state.

## What Changes

- Make PostgreSQL connection errors observable and contained instead of becoming unhandled process-level errors that dump client internals and secrets.
- Make engine ownership retry after temporary lock contention so a restarted process begins work once a stale lock disappears.
- Report engine ownership and progress through readiness/operational status so healthy-but-idle failures are detectable.
- Add regression coverage for disconnects, delayed lock availability, and secret-safe diagnostics.
- Bump the application and reference VPS deployment versions together for release and redeployment.

## Capabilities

### New Capabilities
- `deployment-runtime-resilience`: Defines automatic recovery, safe diagnostics, and truthful health behavior for the long-running deployment runtime.

### Modified Capabilities

None.

## Impact

- PostgreSQL runtime and advisory-lock handling in `packages/store`.
- Engine ownership, service lifecycle, web readiness, and observability in `packages/app`.
- Unit and integration tests for connection failure and engine recovery.
- Published application package and `docker/vps` release pins.
- VPS operator procedure: publish the bumped package, rebuild, and redeploy after confirmation.
