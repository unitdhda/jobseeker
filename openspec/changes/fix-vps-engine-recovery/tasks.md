## 1. PostgreSQL Failure Containment

- [x] 1.1 Add a loss-aware singleton lease contract and safely consume asynchronous client errors without exposing client internals
- [x] 1.2 Guard checked-out transaction clients for their full lifetime, reject on disconnect, and destroy poisoned clients
- [x] 1.3 Add store tests for timeout/disconnect handling, lease loss, idempotent release, and secret-safe errors

## 2. Engine Ownership Supervision

- [x] 2.1 Replace one-shot engine lock acquisition with an interruptible bounded-backoff ownership supervisor
- [x] 2.2 Stop and clean up the active loop on lease loss before retrying, with no concurrent local loops
- [x] 2.3 Add lifecycle tests for initial contention, delayed acquisition, lease loss, recovery, and shutdown while waiting

## 3. Truthful Runtime Health

- [x] 3.1 Expose supervised engine states to service observability and distinguish waiting, running, recovering, and off
- [x] 3.2 Require a live running engine for `/ready` when jobs are enabled while keeping `/health` as liveness
- [x] 3.3 Add web, service, and status tests for healthy-but-waiting and recovered states

## 4. Release Preparation

- [x] 4.1 Run focused tests, full unit tests, typecheck, build, and package smoke validation
- [x] 4.2 Bump application, reference deployment, documentation, and packaging assertions from `0.2.7` to `0.2.8`
- [x] 4.3 Validate the OpenSpec change, review the diff for secrets, commit the complete change, and push it
- [x] 4.4 Tell the operator to publish `@unitdhda/jobseeker@0.2.8` and pause before VPS redeployment

## 5. Post-Publish Redeployment

- [ ] 5.1 After publication confirmation, verify the npm package, back up VPS deployment assets, rebuild the image, and run `doctor`
- [ ] 5.2 Recreate the VPS service and verify readiness, one live advisory lock, progressing overdue units, stable restarts, and sanitized logs
