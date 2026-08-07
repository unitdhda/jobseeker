# Production operations

This is the canonical runbook for validating, deploying, monitoring, and handing off Jobseeker production.

## Where production runs

**Production is one Docker container**, built from a checkout of this repository and run by Compose on a host you
control. Nothing in this runbook depends on what kind of host that is: a rented server, a dedicated box, and your
own laptop run the same image with the same commands, and reaching the host is your own arrangement.

| Surface | State | Role |
|---|---|---|
| Container `jobseeker-jobseeker-1` | live | Telegram receiver (polling) **and** the only engine loop |
| Extension sidecars (optional) | deployment-specific | Services an extension needs, private network only |
| PostgreSQL | live | The only runtime database, shared by every surface |
| Local checkout | development | Same production database; a local run is not a dry run |

Verify ownership before every operation instead of trusting this table. Ownership has moved between hosts before.

This document deliberately records no configuration values, host addresses, or filesystem paths. Read the live
settings from the host's env file when you need them; a copy here would drift and mislead. `.env.example`
documents what each knob means.

Runtime: every `bun <file>` command in this runbook also runs under Node.js 23.6+ — substitute `node`, and add
`--experimental-transform-types` when the entrypoint is a `.ts` file. Bun remains required for `bun install` and
`bun run <script>`, and inside the deployed container, whose image ships Bun only.

## Invariants

- Keep exactly one Telegram receiver per token: today the deployed container's poller, and therefore **no configured
  webhook**. This invariant has no technical guard — Telegram splits updates between two receivers and reports
  nothing wrong. A forgotten local process counts as a second receiver.
- Keep exactly one engine loop: today the container's process with `RUN_JOBS=true`. `search_units.next_run_at` is the
  schedule, and the loop holds a session advisory lock, so a second `RUN_JOBS=true` process logs `Another process
  holds the engine-loop lock` and idles. Treat that line as a misconfiguration to fix, not as a safe topology.
- PostgreSQL is the only runtime database. SQLite files are historical recovery material.
- `packages/app/schema.sql` is the only schema of record; there is no migration series to append to.
- Vacancy sources and any extra AI providers come from the deployment's `extensions/` directory, which is untracked
  on the host. It is a deployment asset: back it up, and never `rsync --delete` or `git clean` over it.
- Do not deploy `OPENAI_API_KEY`; production inference is subscription-backed, not a metered API key. Model roles
  come from the live `AI_*_MODEL` settings read from the host.
- Do not print environment values, Telegram credentials, database URLs, OAuth state, encryption keys, or personal data.
- Use Jujutsu bookmarks and workspaces; do not create Git branch workflows.

## How to run these commands

Run the repository commands (`bun run …`, `jj …`) from your checkout, and the Docker commands from the deployment
directory on the host — the one holding `compose.yaml` and the deployment's `.env`. How you get a shell there is
your business: SSH, a remote Docker context, or sitting at the machine. Nothing in this runbook depends on the
answer.

```bash
cd <deployment directory>   # holds compose.yaml and .env
docker compose ps
```

Two directories on the host matter and they are usually not the same one: the **deployment directory** above, and
the **source checkout** the image is built from. Commands below say which one they expect.

**Host addresses, ports, paths, and credentials stay in local configuration, never in this repository.** Never guess
them; ask instead.

## Production status

Status checks must not change ownership.

### The live container

```bash
docker ps --format "{{.Names}}\t{{.Status}}"    # every container on the host
docker compose ps                                # this deployment only
```

`jobseeker-jobseeker-1` must be up. If the standby sidecar is retained, it must be healthy and have no published
host port. Confirm the deployed revision and that the working tree is clean:

```bash
# in the source checkout on the host
git log --oneline -3 && git status --short
```

The `/scraper` owner command and recent engine-stage logs usually answer an operational question without forcing
work:

```bash
docker compose logs --since 2h jobseeker | grep -E 'Engine (tick|discovery|judgment|score|deliver)' | tail -30
```

### Local receivers and producers

```bash
pgrep -afil 'dist/(server|worker|run-cycle)\.mjs' || true
```

A PID file is not authoritative. Confirm the process command before changing ownership. Nothing should be running
here during normal operation.

### Telegram receiver ownership without exposing credentials

Use the local token only to print redacted status fields:

```bash
bun --env-file=.env - <<'BUN'
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
const body = await response.json();
if (!body.ok) throw new Error('Telegram webhook inspection failed.');
console.log(JSON.stringify({
  configured: Boolean(body.result.url),
  https: body.result.url?.startsWith('https://') ?? false,
  pending: body.result.pending_update_count,
  lastError: Boolean(body.result.last_error_message),
  maxConnections: body.result.max_connections,
}));
BUN
```

Do not print the webhook URL because it may contain routing information. **While the deployed container polls,
healthy production reports `configured: false`.** A configured webhook at the same time as the poller means updates
are being split or double-handled — resolve ownership immediately. A deployment that deliberately runs
`TELEGRAM_MODE=webhook` inverts the healthy state: a configured HTTPS webhook, zero or draining pending updates, and
no current error — and then no poller anywhere.

## Validation baseline

Use the package scripts so tests run with the repository's explicit environment isolation.

```bash
bun run typecheck
bun run test
bun run build
bun run test:postgres
jj status
```

All four validation commands must pass before any deployment. The PostgreSQL integration test uses temporary rows
and cleans them up. `jj status` is a review step, not a gate.

## Database schema

`packages/app/schema.sql` is the schema of record: applying it to an empty database produces a runnable
environment (`jobseeker db init` does exactly that). There is no incremental migration series.

To change the schema:

1. Edit `packages/app/schema.sql` in the same change as the code that needs it.
2. For live deployments, apply the delta as a reviewed one-off statement, then verify the live schema matches the
   file before deploying dependent code.
3. Run `bun run test:postgres` after application.

Do not place database passwords on command lines or in logs.

Every surface shares one database, so a schema change reaches the running container the moment it is applied,
before any code ships. Apply only changes the running revision tolerates, or take the bot down first.

## Release workflow

This is the normal release path.

### 1. Preflight

- Run the full validation baseline locally.
- Publish the tested revision: `jj bookmark set main -r @` and `jj git push --bookmark main`. Another session may
  have moved `main`; inspect the graph before setting it.
- **Check the deploy line has not diverged.** Confirm what the host runs is an ancestor of what you are about to
  ship:

  ```bash
  # in the source checkout on the host
  git rev-parse HEAD && git status --short
  ```

  A dirty tree or a commit absent from `main` means production carries edits recorded in no revision. Diff and
  preserve them before resetting; they have been destroyed this way before.
- Confirm no local producer is active: nothing else may hold the engine-loop lock or poll the token.
- Note the current image and container start time so a rollback has a target.

### 2. Ship the source

```bash
# in the source checkout on the host
git fetch origin main && git reset --hard FETCH_HEAD && git log --oneline -1
```

**Never run `git clean` there, and never `rsync --delete` onto it.** `.gitignore` excludes `fonts/`, `/scripts/`, and
the deployment's own `extensions/`, all of which the build needs; removing them breaks the image or silently strips
the deployment's vacancy sources.

### 3. Rebuild and restart

```bash
docker compose --env-file .env up -d --build jobseeker
```

The build takes several minutes. **Wait by polling, never with a blind `sleep`** — poll the condition and return
the moment it holds, with a deadline so a failed build cannot hang the operation:

```bash
deadline=$(( $(date +%s) + 900 ))
until docker ps --format '{{.Names}} {{.Status}}' | grep -q '^jobseeker-jobseeker-1 Up'; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo 'TIMEOUT'; docker compose ps; break; }
  sleep 5
done
```

Restarting `jobseeker` alone leaves the sidecar running; it costs nothing while idle.

### 4. Validate the running revision

```bash
docker compose logs --since 10m jobseeker | grep -iE 'error|fatal' | tail -20
docker compose exec -T jobseeker bun -e \
  'const p = process.env.PORT; for (const r of ["health", "ready"]) console.log(r, await (await fetch(`http://localhost:${p}/${r}`)).text())'
```

The image ships no `curl` or `wget`, so probe from inside with `bun`; the container reads its own port from the
environment, which keeps the address out of this document. `/ready` must report PostgreSQL persistence.

Then confirm the receiver is alive by sending one inexpensive command to the bot. Do not force a discovery pass;
wait for the engine to run a due unit and for the independent two-minute judgment lane to report normal work:

```bash
deadline=$(( $(date +%s) + 2700 ))
until docker compose logs --since 45m jobseeker | grep -q 'Engine tick finish'; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo 'TIMEOUT'; break; }
  docker compose logs --since 45m jobseeker | grep -c 'Engine'
  sleep 30
done
```

A due unit may legitimately be up to `UNIT_CADENCE_CEILING_MINUTES` away; the deadline above is a reporting bound,
not a failure threshold.

Use `/scraper` for aggregate discovery, normalization, scoring, unit-health, and parser-error counters; inspect
engine stage errors in logs without dumping vacancy or user payloads.

### 5. Verify inference still routes through the sidecar

```bash
docker compose logs --since 1h jobseeker | grep 'LLM cycle usage' | tail -2
```

`byModel` must agree with the role-specific `AI_*_MODEL` values read from the host. Production currently routes
through the provider named by the host's `AI_*_MODEL` settings, so `byModel` must agree with them; another
provider appears only after an intentional fallback or model switch.

### Rollback

Reset the checkout to the last-known-good commit and rebuild the same way. Recovery of an image alone is possible
only because the classic Docker builder retains build-stage layers — do not rely on it. Roll back schema-dependent
code by shipping a forward-compatible revision, not by reverting an applied schema change.

## Local testing

Prefer unit and integration tests. `bun run test` needs no database; `bun run test:postgres` writes temporary rows
to the production database and cleans them up.

Do not start local polling with the production token — it becomes a second receiver. If an explicit rollback
requires it:

1. Stop the deployed bot (`docker compose stop jobseeker`) and confirm the container has exited.
2. Wait longer than the previous receiver's polling interval.
3. Start exactly one local process with `TELEGRAM_MODE=polling`.
4. Verify its health and confirm no second receiver exists.
5. To hand back, stop the local process, wait for it to exit, then `docker compose up -d jobseeker` and re-verify
   ownership.

**Never start a local engine loop while production owns the schedule.** There is no advisory lock to make this
safe: a second `RUN_JOBS=true` process can perform duplicate discovery and delivery against the production database.

## Logs and incident triage

### The live bot

```bash
docker compose logs --since 1h jobseeker | grep -iE 'error|fatal' | tail -50
docker compose logs --since 6h jobseeker | grep -E 'Engine (tick|discovery|judgment|score|deliver)'
docker stats --no-stream
```

The `/scraper` funnel is the first thing to read: most "why is nothing arriving" questions are a throttled stage,
not a failure. Each stage is bounded on purpose — discovery volume and delivered volume are unrelated.

### The inference sidecar

```bash
docker compose logs --since 1h <sidecar service> | tail -50
docker compose ps --format "{{.Service}} {{.Status}}"
```

The sidecar carries a Docker healthcheck, so its `Status` is the authoritative readiness signal — it must report
`(healthy)`. The bot container has no healthcheck and no HTTP client installed, so use the `bun` probe above.

A restarting sidecar surfaces as a scoring error absorbed by `SCORING_BATCH_MAX_ATTEMPTS`; there is no separate
transport-level backoff.

### Pipeline diagnostics

These read the shared database from the local checkout and change nothing:

```bash
bun --env-file=.env scripts/source-funnel.ts '7 days'   # discovery → prefilter → normalization → score, per source
bun scripts/probe-sources.ts                                  # adapter feasibility of candidate sources
```

Feasibility depends on egress IP: some boards answer the deployment's network but not your laptop. Probe from the
host that actually scrapes them. Judge a source by its prefilter pass rate, not its discovery count — prefilter
scores are not comparable across sources, which is why the normalization queue carries a per-source quota.

## Verify against a clock you actually read

"Stale since 04:00" means nothing without `select now()`. Compare timestamps against the database clock and each
unit's `next_run_at`; judgment wakes independently every two minutes.

## Post-operation report

Report, without secrets or personal data:

- tested commit/bookmark, and the commit the live surface actually runs;
- which surface owns Telegram and the engine loop;
- container states and the sidecar health result;
- `/health` and `/ready` result;
- Telegram webhook configured/pending/error booleans;
- the extensions the running revision loaded, and how many source providers they registered;
- local ownership state;
- cycle duration, discovery/normalization/scoring totals, delivery counts, and error count;
- any intentionally stopped or paused component and remaining follow-up.
