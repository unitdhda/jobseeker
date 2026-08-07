# Production operations

This is the canonical runbook for validating, deploying, monitoring, and handing off Jobseeker production.

## Where production runs

**Production is a Docker deployment on a VPS**, built from a checkout of this repository.

| Surface | State | Role |
|---|---|---|
| VPS `jobseeker-jobseeker-1` | live | Telegram receiver (polling) **and** the only engine loop |
| Extension sidecars (optional) | deployment-specific | Services an extension needs, private network only |
| Supabase PostgreSQL | live | The only runtime database, shared by every surface |
| Local checkout | development | Same production database; a local cycle is not a dry run |

Verify ownership before every operation instead of trusting this table. Ownership has moved between surfaces before.

This document deliberately records no configuration values, host addresses, or filesystem paths. Read the live
settings from the host's env file when you need them; a copy here would drift and mislead. `.env.example`
documents what each knob means.

Runtime: every `bun <file>` command in this runbook also runs under Node.js 23.6+ — substitute `node`, and add
`--experimental-transform-types` when the entrypoint is a `.ts` file. Bun remains required for `bun install` and
`bun run <script>`, and inside the deployed container, whose image ships Bun only.

## Invariants

- Keep exactly one Telegram receiver per token: today the VPS poller, and therefore **no configured webhook**. This
  invariant has no technical guard — Telegram splits updates between two receivers and reports nothing wrong.
- Keep exactly one engine loop: today the VPS process with `RUN_JOBS=true`. `search_units.next_run_at` is the
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

## Shell setup

Run everything from the repository root.

**Host connection details and directory layout stay in local configuration, never in this repository.** Supply them
as environment variables and drive the host through these helpers, so no command below names an address, a port, or
a path. Never guess credentials or locations; ask instead.

```bash
export VPS_SSH_TARGET='...'    # user@host, or a Host alias from local SSH configuration
export VPS_SSH_PORT=''         # only when the alias does not carry it
export VPS_DEPLOY_DIR='...'    # directory holding compose.yaml and .env on the host
export VPS_SRC_DIR='...'       # application source checkout on the host

vps()     { ssh ${VPS_SSH_PORT:+-p "$VPS_SSH_PORT"} "$VPS_SSH_TARGET" "$@"; }
compose() { vps "cd '$VPS_DEPLOY_DIR' && docker compose $*"; }
src()     { vps "cd '$VPS_SRC_DIR' && $*"; }
```

Confirm the host before any mutating command. Never infer it from an old log or copied URL.

## Production status

Status checks must not change ownership.

### The live VPS

```bash
vps 'docker ps --format "{{.Names}}\t{{.Status}}"'
compose ps
```

`jobseeker-jobseeker-1` must be up. If the standby sidecar is retained, it must be healthy and have no published
host port. Confirm the deployed revision and that the working tree is clean:

```bash
src 'git log --oneline -3 && git status --short'
```

The `/scraper` owner command and recent engine-stage logs usually answer an operational question without forcing
work:

```bash
compose 'logs --since 2h jobseeker' | grep -E 'Engine (tick|discovery|judgment|score|deliver)' | tail -30
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

Do not print the webhook URL because it may contain routing information. **With the VPS polling, healthy production
reports `configured: false`.** A configured webhook at the same time as the poller means updates are being split or
double-handled — resolve ownership immediately. A deployment that deliberately runs `TELEGRAM_MODE=webhook` inverts
the healthy state: a configured HTTPS webhook, zero or draining pending updates, and no current error — and then no
poller anywhere.

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

Every surface shares one database, so a schema change reaches the live VPS the moment it is applied, before any
code ships. Apply only changes the running revision tolerates, or take the bot down first.

## Release workflow — the live VPS

This is the normal release path.

### 1. Preflight

- Run the full validation baseline locally.
- Publish the tested revision: `jj bookmark set main -r @` and `jj git push --bookmark main`. Another session may
  have moved `main`; inspect the graph before setting it.
- **Check the deploy line has not diverged.** Confirm what the VPS runs is an ancestor of what you are about to ship:

  ```bash
  src 'git rev-parse HEAD && git status --short'
  ```

  A dirty tree or a commit absent from `main` means production carries edits recorded in no revision. Diff and
  preserve them before resetting; they have been destroyed this way before.
- Confirm no local producer is active: nothing else may hold the engine-loop lock or poll the token.
- Note the current image and container start time so a rollback has a target.

### 2. Ship the source

```bash
src 'git fetch origin main && git reset --hard FETCH_HEAD && git log --oneline -1'
```

**Never run `git clean` there.** `.gitignore` excludes `fonts/` and `/scripts/`, which the build needs, and removing
them breaks the image.

### 3. Rebuild and restart

```bash
compose '--env-file .env up -d --build jobseeker'
```

The build takes several minutes. **Wait by polling, never with a blind `sleep`** — `scripts/vps-wait.sh` runs a
condition in one SSH session and returns the moment it holds:

```bash
scripts/vps-wait.sh 'docker ps --format "{{.Names}} {{.Status}}" | grep -q "^jobseeker-jobseeker-1 Up"' 900 5 \
  'docker ps --format "{{.Names}} {{.Status}}" | grep jobseeker-jobseeker-1'
```

Restarting `jobseeker` alone leaves the sidecar running; it costs nothing while idle.

### 4. Validate the running revision

```bash
compose 'logs --since 10m jobseeker' | grep -iE 'error|fatal' | tail -20
compose 'exec -T jobseeker bun -e "const p=process.env.PORT; for (const r of [\"health\",\"ready\"]) console.log(r, await (await fetch(\"http://localhost:\"+p+\"/\"+r)).text())"'
```

The image ships no `curl` or `wget`, so probe from inside with `bun`; the container reads its own port from the
environment, which keeps the address out of this document. `/ready` must report PostgreSQL persistence.

Then confirm the receiver is alive by sending one inexpensive command to the bot. Do not force a discovery pass;
wait for the engine to run a due unit and for the independent two-minute judgment lane to report normal work:

```bash
scripts/vps-wait.sh \
  "cd '$VPS_DEPLOY_DIR' && docker compose logs --since 45m jobseeker | grep -q 'Engine tick finish'" 2700 30 \
  "cd '$VPS_DEPLOY_DIR' && docker compose logs --since 45m jobseeker | grep -c 'Engine'"
```

Use `/scraper` for aggregate discovery, normalization, scoring, unit-health, and parser-error counters; inspect
engine stage errors in logs without dumping vacancy or user payloads.

### 5. Verify inference still routes through the sidecar

```bash
compose 'logs --since 1h jobseeker' | grep 'LLM cycle usage' | tail -2
```

`byModel` must agree with the role-specific `AI_*_MODEL` values read from the host. Production currently routes
through the provider named by the host's `AI_*_MODEL` settings, so `byModel` must agree with them; another
provider appears only after an intentional fallback or model switch.

### Rollback on the VPS

Reset the checkout to the last-known-good commit and rebuild the same way. Recovery of an image alone is possible
only because the classic Docker builder retains build-stage layers — do not rely on it. Roll back schema-dependent
code by shipping a forward-compatible revision, not by reverting an applied schema change.

## Local testing

Prefer unit and integration tests. `bun run test` needs no database; `bun run test:postgres` writes temporary rows
to the production database and cleans them up.

Do not start local polling with the production token — it becomes a second receiver. If an explicit rollback
requires it:

1. Stop the VPS bot and confirm the container has exited.
2. Wait longer than the previous receiver's polling interval.
3. Start exactly one local process with `TELEGRAM_MODE=polling`.
4. Verify its health and confirm no second receiver exists.
5. To hand back, stop the local process, wait for it to exit, then start the VPS bot again and re-verify ownership.

**Never start a local engine loop while production owns the schedule.** There is no advisory lock to make this
safe: a second `RUN_JOBS=true` process can perform duplicate discovery and delivery against the production database.

## Logs and incident triage

### The live bot

```bash
compose 'logs --since 1h jobseeker' | grep -iE 'error|fatal' | tail -50
compose 'logs --since 6h jobseeker' | grep -E 'Engine (tick|discovery|judgment|score|deliver)'
vps 'docker stats --no-stream $(vps "docker ps --format {{.Names}}" | tr "\n" " ")'
```

The `/scraper` funnel is the first thing to read: most "why is nothing arriving" questions are a throttled stage,
not a failure. Each stage is bounded on purpose — discovery volume and delivered volume are unrelated.

### The inference sidecar

```bash
compose 'logs --since 1h <sidecar service>' | tail -50
compose 'ps --format "{{.Service}} {{.Status}}"'
```

The sidecar carries a Docker healthcheck, so its `Status` is the authoritative readiness signal — it must report
`(healthy)`. The bot container has no healthcheck and no HTTP client installed, so use the `bun` probe above.

A restarting sidecar surfaces as a scoring error absorbed by `SCORING_BATCH_MAX_ATTEMPTS`; there is no separate
transport-level backoff.

### Pipeline diagnostics

These read the shared database from the local checkout and change nothing:

```bash
# DATABASE_URL lives in .env.cloud, not .env, so the funnel needs it named explicitly.
bun --env-file=.env.cloud scripts/source-funnel.ts '7 days'   # discovery → prefilter → normalization → score, per source
bun scripts/probe-sources.ts                                  # adapter feasibility of candidate sources
```

Feasibility depends on egress IP: some Russian boards answer the VPS but not a local machine. Probe from the VPS,
because that is what scrapes them. Judge a source by its prefilter pass rate, not its discovery count — prefilter
scores are not comparable across sources, which is why the normalization queue carries a per-source quota.

## Verify against a clock you actually read

"Stale since 04:00" means nothing without `select now()`. Compare timestamps against the database clock and each
unit's `next_run_at`; judgment wakes independently every two minutes.

## Post-operation report

Report, without secrets or personal data:

- tested commit/bookmark, and the commit the live surface actually runs;
- which surface owns Telegram and the engine loop;
- VPS container states and the sidecar health result;
- `/health` and `/ready` result;
- Telegram webhook configured/pending/error booleans;
- the extensions the running revision loaded, and how many source providers they registered;
- local ownership state;
- cycle duration, discovery/normalization/scoring totals, delivery counts, and error count;
- any intentionally stopped or paused component and remaining follow-up.
