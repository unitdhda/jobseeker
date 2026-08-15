## Context

The service uses a session-level PostgreSQL advisory lock to ensure one engine loop. Lock acquisition currently happens once during startup. A failed acquisition returns an inert ownership object forever. PostgreSQL clients can also emit `error` while checked out or while carrying the singleton lock; without a managed listener this terminates Node and logs a serialized error context containing runtime secrets. With Supavisor, the server-side session can retain the advisory lock briefly after the container exits, so Docker restart races the stale lease.

The HTTP liveness and readiness endpoints currently validate only process and database availability. They cannot identify that required background work stopped.

## Goals / Non-Goals

**Goals:**
- Convert asynchronous PostgreSQL client errors into explicit operation or lease failure.
- Supervise engine ownership for the lifetime of the service with bounded retry.
- Stop a loop before replacing a lost ownership lease.
- Make readiness and operator status reflect engine ownership.
- Preserve safe, compact errors without serializing clients, configuration, or credentials.

**Non-Goals:**
- Replace PostgreSQL advisory locks or Supavisor.
- Add multi-replica Telegram ownership.
- Change search cadence, scoring policy, or database schema.
- Automate npm publication; publication remains an explicit operator action.

## Decisions

### Represent singleton ownership as a loss-aware lease

The store will return a lease with an idempotent release operation and a promise/signal that settles when its underlying client emits an asynchronous error. The client error listener consumes the EventEmitter error and records only a normalized connection failure. A plain release callback cannot tell the engine that ownership disappeared.

Alternative: merely add a no-op error listener. Rejected because the engine could continue running after its advisory lock was lost and violate singleton execution.

### Supervise acquisition instead of treating contention as terminal

Engine ownership will run an acquisition loop with bounded backoff and an interruptible stop signal. On first acquisition it initializes resources and starts one engine loop. On lease loss it stops that loop but retains initialized source providers and extension hooks, because the source registry's close operation is irreversible. After reacquisition it creates a fresh loop over those retained resources. Final service shutdown closes sources and hooks; initial initialization failure cleans them up and fails startup. Status will expose `waiting`, `running`, `recovering`, and `off`-appropriate information without retaining a stale loop reference.

Alternative: fully recompose the application after every lease loss. Rejected because ownership supervision does not own the store, source registry, AI models, worker, or Telegram resources required to rebuild composition safely. Relying on Docker restart is also rejected because the pooler can retain the previous session lock beyond container exit, reproducing permanent idle state.

### Guard checked-out clients for their full transaction lifetime

Transaction handling will install a temporary error listener before use, race/propagate asynchronous disconnects through the transaction operation, poison the client, and always remove the listener/release safely. Pool-level query retries remain bounded as today.

Alternative: globally suppress uncaught errors. Rejected because it hides ownership loss and does not safely retire broken clients.

### Separate liveness from readiness

`/health` remains process liveness. `/ready` checks persistence and, when jobs are enabled, requires a live running engine lease. Engine state is injected into web ports rather than coupled directly to engine implementation. Operator runtime status uses the same supervised state.

Alternative: fail liveness when ownership is absent. Rejected because Docker restart loops worsen stale-lock races and prevent in-process recovery.

### Release as the next patch version

The package and reference deployment will move from `0.2.7` to `0.2.8` together. The existing manual provenance workflow publishes the package. Deployment rebuild and restart occur only after the user confirms publication.

## Risks / Trade-offs

- [Readiness remains failed during legitimate lock contention] → This is intentional for the single-service VPS topology and exposes that the replica cannot perform required work.
- [Initialized providers remain open while ownership is unavailable] → Stop the engine loop before releasing/retrying the lease so no provider work runs, and close providers only during final shutdown.
- [Rapid database flapping creates repeated loop construction] → Bound retry delay and guarantee serialized loop stop/start without rerunning provider initialization.
- [An operation ignores cancellation after its client disconnects] → Poison and release the client only after managed operation unwinds; do not reuse it.
- [Changing ownership interfaces affects tests and composition] → Keep the change internal to store/app packages and cover the lifecycle with focused unit tests.

## Migration Plan

1. Implement and test guarded PostgreSQL clients, loss-aware singleton leases, supervised engine ownership, and readiness/status integration.
2. Run typecheck, unit tests, build, packaging tests, and external tarball smoke checks as applicable.
3. Bump all release pins to `0.2.8`, commit, and push.
4. Ask the operator to run the manual provenance publication workflow and wait for confirmation that `@unitdhda/jobseeker@0.2.8` is available.
5. On the VPS, back up deployment assets, update/rebuild the deployment from the published package, run `doctor`, and recreate the service.
6. Verify one advisory lock, running engine readiness, decreasing overdue units, and absence of secret-bearing errors.

Rollback uses the prior `0.2.7` image only if its database expectations remain compatible. The database schema is unchanged.
