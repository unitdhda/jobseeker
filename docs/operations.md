# Production operations

This is the canonical runbook for validating, deploying, monitoring, and handing off Jobseeker production.

## Where production runs

**Production is a Docker deployment on a VPS.** Cloud Run is provisioned, deployed, and deliberately idle.

| Surface | State | Role |
|---|---|---|
| VPS `jobseeker-jobseeker-1` | live | Telegram receiver (polling) **and** the only engine loop |
| VPS `jobseeker-claude-cli-1` | live, idle | Standby Claude Code inference sidecar, private network only |
| Supabase PostgreSQL | live | The only runtime database, shared by every surface |
| Cloud Run `jobseeker-web` / `jobseeker-worker` | deployed, idle | Staged alternative; no Telegram webhook points at them |
| Cloud Run Jobs `jobseeker-cycle` / `jobseeker-profile-refresh` | deployed, idle | Executed only for staged validation |
| Cloud Scheduler `jobseeker-cycle` | `PAUSED` | Would become the producer on cutover back to cloud |
| Local checkout | development | Same production database; a local cycle is not a dry run |

Verify ownership before every operation instead of trusting this table. Ownership has moved between surfaces before.

This document deliberately records no configuration values, host addresses, or filesystem paths. Read the live
settings from the host's env file when you need them; a copy here would drift and mislead. `.env.example`
documents what each knob means.

Runtime: every `bun <file>` command in this runbook also runs under Node.js 24+ — substitute `node`, and add
`--experimental-transform-types` when the entrypoint is a `.ts` file. Bun remains required for `bun install` and
`bun run <script>`, and inside the deployed container, whose image ships Bun only.

## Invariants

- Keep exactly one Telegram receiver per token: today the VPS poller, and therefore **no configured webhook**.
- Keep exactly one engine loop: today the VPS process with `RUN_JOBS=true`, and therefore Cloud Scheduler stays
  paused and no local process starts the loop. There is no scheduler advisory lock: `search_units.next_run_at` is
  the schedule, and a second loop can scrape concurrently and send duplicate alerts or digests.
- PostgreSQL is the only runtime database. SQLite files are historical recovery material.
- Cloud Tasks must remain bounded at one concurrent dispatch and one dispatch per second unless a new bound is explicitly approved.
- Do not deploy `OPENAI_API_KEY`; production uses the `openai-codex` OAuth credential in encrypted runtime state,
  not a metered API key. Model roles come from the live `AI_*_MODEL` settings. The Claude sidecar is standby.
- Do not print environment values, Telegram credentials, database URLs, OAuth state, encryption keys, or personal data.
- Historical Supabase migrations are immutable. Add forward migrations only.
- Use Jujutsu bookmarks and workspaces; do not create Git branch workflows.

## Shell setup

Run everything from the repository root.

```bash
export GCP_PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
export GCP_REGION="${GCP_REGION:-europe-west1}"
```

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

Confirm the selected project and host before any mutating command. Never infer them from an old log or copied URL.

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

### Cloud services

```bash
for service in jobseeker-web jobseeker-worker; do
  gcloud run services describe "$service" \
    --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
    --format='yaml(status.latestReadyRevisionName,status.conditions,spec.template.metadata.annotations,spec.template.spec.containerConcurrency)'
done

gcloud scheduler jobs describe jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --format='value(state,schedule,timeZone)'

gcloud tasks queues describe jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --format='value(state,rateLimits.maxConcurrentDispatches,rateLimits.maxDispatchesPerSecond)'
```

While the VPS owns production, Scheduler must be `PAUSED`. The queue may remain `RUNNING` at concurrency `1` and
dispatch rate `1.0`; it is idle because nothing enqueues to it.

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
double-handled — resolve ownership immediately. If Cloud Run ever reclaims production, the healthy state inverts: a
configured HTTPS webhook, zero or draining pending updates, and no current error.

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

`supabase/schema.sql` is the schema of record: it describes the database the application expects, and applying it
to an empty database produces a runnable environment. It is generated from the live database, so it reflects what is
actually deployed rather than what a migration series intended.

Incremental migration files under `supabase/migrations/` are **not** version controlled. They remain on the machine
that applies them, because the Supabase CLI needs them to reconcile with the remote ledger, but they are working
material rather than a published record.

To change the schema:

1. Write the change as a timestamped migration under `supabase/migrations/` locally.
2. Never edit a migration already applied remotely; the remote ledger records it.
3. Review destructive statements and constraints before applying.
4. Apply it to the linked Supabase project and verify before deploying dependent code.
5. Regenerate `supabase/schema.sql` from the live database and commit that.
6. Run `bun run test:postgres` after application.

Use the project's existing Supabase linkage and local secret files. Do not place database passwords on command lines or in logs.

Because the migration series is not published, the repository carries no upgrade path for an existing database —
`schema.sql` builds a new one. A clone without the local migration files cannot run `supabase db push`.

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
- Confirm no local producer is active and Cloud Scheduler is paused.
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
through `openai-codex` OAuth; a `claude-cli/*` entry is expected only after an intentional fallback or model switch.

### Rollback on the VPS

Reset the checkout to the last-known-good commit and rebuild the same way. Recovery of an image alone is possible
only because the classic Docker builder retains build-stage layers — do not rely on it. Roll back schema-dependent
code by shipping a forward-compatible revision, not by reverting an applied migration.

## Release workflow — the staged Cloud Run surface

Use this only when deliberately validating or reclaiming the cloud path. `scripts/deploy-gcp.sh` builds two images,
deploys the worker, web service, cycle job, and manual profile-repair job, then deliberately pauses Cloud Scheduler.
It does not alter the Telegram webhook and does not execute either job, so it is safe to run while the VPS owns
production.

### 1. Preflight ownership

- Confirm no local production poller or local scheduled producer is active.
- Record the current ready web and worker revisions.
- Confirm the task queue is bounded at `1/1`.
- Note that the VPS still owns Telegram and the schedule; deploying does not change that.

### 2. Validate and publish the commit

```bash
bun run typecheck
bun run test
bun run build
bun run test:postgres
jj status
jj bookmark set cloud -r @
jj git push --bookmark cloud
```

Do not move `cloud` to an untested working copy. If the working copy contains unrelated changes, separate them before release.

### 3. Deploy

```bash
GCP_PROJECT_ID="$GCP_PROJECT_ID" GCP_REGION="$GCP_REGION" ./scripts/deploy-gcp.sh
```

The script reads `.env` and `.env.cloud` without uploading them, verifies Secret Manager versions, uses Cloud Build, and preserves bounded scaling. It pauses Scheduler even when it was previously enabled.

### 4. Validate staged revisions

```bash
WEB_URL="$(gcloud run services describe jobseeker-web \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
curl -fsS "$WEB_URL/health"
curl -fsS "$WEB_URL/ready"

gcloud scheduler jobs describe jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --format='value(state)'
```

Scheduler must be `PAUSED`. Inspect errors for only the new revisions:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND (resource.labels.service_name="jobseeker-web" OR resource.labels.service_name="jobseeker-worker") AND severity>=ERROR' \
  --project="$GCP_PROJECT_ID" --freshness=30m --limit=100 \
  --format='value(timestamp,resource.labels.service_name,resource.labels.revision_name,severity,textPayload,jsonPayload.message)'
```

Redact any unexpected personal data before sharing output.

### 5. Repair missing profiles when needed

The repair job checks approved users with CVs and generates only missing or invalid career/platform profiles. It does not scrape,
normalize, score, deliver, or own a schedule:

```bash
gcloud run jobs execute jobseeker-profile-refresh \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --wait
```

Its final summary must report zero failures. Running it may consume profile-generation quota and AI usage, so do not invoke it as a
routine health check. It writes to the shared production database and is safe to run while the VPS polls, because it
neither receives Telegram updates nor delivers anything.

### 6. Run one controlled cycle

**This competes with the live VPS engine and there is no cross-surface scheduler lock.** Only run it during a
deliberate cutover, and stop the VPS bot first:

```bash
compose 'stop jobseeker'
gcloud run jobs execute jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --wait
```

Inspect the named execution. It must finish with one successful task and no failed task. Review its logs for:

- `Vacancy cycle complete`;
- per-platform discovery, including HireHi;
- completed score counts;
- queued delivery tasks;
- PostgreSQL, scrape, normalization, scoring, and AI errors.

Confirm queued tasks drain and the private worker has no errors:

```bash
gcloud tasks list --queue=jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION"
```

### 7. Restore scheduled ownership

Only during a real cutover, and only after the controlled cycle succeeds:

```bash
gcloud scheduler jobs resume jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet
```

Then re-run the status checks. Verify exactly one receiver, Scheduler enabled, queue running at `1/1`, no local
pollers, the VPS bot stopped, and a healthy webhook. If this was only staged validation, restart the VPS bot
instead and leave Scheduler paused.

## Ownership handoff

The two surfaces cannot both receive Telegram updates. Handing off means moving both the receiver and the producer
together, and the order matters because Telegram silently splits updates between a poller and a webhook.

### VPS → Cloud Run

1. Confirm the Cloud Run revisions are deployed and healthy, and Scheduler is paused.
2. Stop the VPS bot: `compose 'stop jobseeker'`. Leave the sidecar running.
3. Wait longer than the polling timeout and confirm the container has exited.
4. Configure the webhook, keeping pending updates:

   ```bash
   WEB_URL="$(gcloud run services describe jobseeker-web \
     --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
   TELEGRAM_WEBHOOK_URL="$WEB_URL/telegram/webhook" \
     bun --env-file=.env --env-file=.env.cloud src/scripts/set-telegram-webhook.ts
   ```

5. Verify the webhook reports configured, HTTPS, and no error; test `/start` and one inexpensive command.
6. Run one controlled cycle job, then resume Scheduler.

Normal Cloud Run deployments keep the same service URL, so the webhook does not need resetting; configure it only
for initial cutover, token rotation, or an explicit return from polling.

### Cloud Run → VPS

1. Pause Cloud Scheduler.
2. Delete the Telegram webhook without dropping pending updates.
3. Wait longer than the webhook transition interval.
4. Start the VPS bot: `compose '--env-file .env up -d jobseeker'`.
5. Verify exactly one receiver, `/health` and `/ready` on the host, and normal discovery/judgment lane activity.

## Local testing

Prefer unit and integration tests. `bun run test` needs no database; `bun run test:postgres` writes temporary rows
to the production database and cleans them up.

Do not start local polling with the production token — it becomes a second receiver. If an explicit rollback
requires it:

1. Stop the VPS bot and confirm it has exited, or pause Cloud Scheduler and clear the webhook, depending on who owns production.
2. Wait longer than the previous receiver's polling or webhook transition interval.
3. Start exactly one local process with `TELEGRAM_MODE=polling`.
4. Verify its health and confirm no second receiver exists.
5. To hand back, stop the local process, wait for it to exit, and follow the handoff sequence above.

**Never start a local engine loop while production owns the schedule.** There is no advisory lock to make this
safe: a second `RUN_JOBS=true` process can perform duplicate discovery and delivery against the production database.

## Logs and incident triage

### The live bot

```bash
compose 'logs --since 1h jobseeker' | grep -iE 'error|fatal' | tail -50
compose 'logs --since 6h jobseeker' | grep -E 'Engine (tick|discovery|judgment|score|deliver)'
vps 'docker stats --no-stream jobseeker-jobseeker-1 jobseeker-claude-cli-1'
```

The `/scraper` funnel is the first thing to read: most "why is nothing arriving" questions are a throttled stage,
not a failure. Each stage is bounded on purpose — discovery volume and delivered volume are unrelated.

### The inference sidecar

```bash
compose 'logs --since 1h claude-cli' | tail -50
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

### Cloud Run, when the staged surface is in play

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="jobseeker-worker" AND severity>=ERROR' \
  --project="$GCP_PROJECT_ID" --freshness=1h --limit=100

gcloud run jobs executions list --job=jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --limit=10

gcloud tasks list --queue=jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --format='table(name.basename(),scheduleTime,dispatchCount,responseCount)'
```

Use an execution name to constrain logs; do not dump unrestricted production logs. If tasks repeatedly fail, pause
the queue before making destructive changes, inspect the private worker revision and OIDC/IAM configuration, deploy
or roll back the worker, then resume the queue. Do not delete tasks merely to make the queue appear healthy.

The worker's external URL can return 404 because ingress is internal; validate it through Cloud Tasks and logs
rather than public curl.

## Cloud Run rollback

Cloud Run keeps previous revisions. A failed new web revision should receive no traffic if it never became ready. If a ready revision is faulty:

1. Pause Scheduler.
2. Pause the task queue if worker processing is unsafe; keep it running for a web-only rollback when the worker is healthy.
3. Route the affected service back to its recorded last-known-good revision.
4. Redeploy the cycle job with the last-known-good worker image if cycle code changed.
5. Verify `/health`, `/ready`, webhook status, queue delivery, and error logs.
6. Run a controlled cycle if worker/cycle code changed.
7. Resume the queue and Scheduler only after validation.

Rollback uses PostgreSQL state already written by cloud revisions. Never roll back to a stale SQLite snapshot.

## Verify against a clock you actually read

"Stale since 04:00" means nothing without `select now()`. Compare timestamps against the database clock and each
unit's `next_run_at`; judgment wakes independently every two minutes.

## Post-operation report

Report, without secrets or personal data:

- tested commit/bookmark, and the commit the live surface actually runs;
- which surface owns Telegram and the schedule;
- VPS container states and the sidecar health result, or deployed cloud revisions and cycle execution;
- `/health` and `/ready` result;
- Telegram webhook configured/pending/error booleans;
- Scheduler and queue state and bounds;
- local ownership state;
- cycle duration, discovery/normalization/scoring totals, delivery counts, and error count;
- any intentionally stopped or paused component and remaining follow-up.
