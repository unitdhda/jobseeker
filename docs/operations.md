# Production operations

This is the canonical runbook for validating, deploying, monitoring, and handing off Jobseeker production.

## Invariants

- Keep exactly one Telegram receiver per token: the production webhook or one local poller.
- Keep exactly one scheduled scrape producer: Cloud Scheduler or one local process with `RUN_JOBS=true`.
- PostgreSQL advisory locking is a final safety guard, not a substitute for explicit ownership.
- PostgreSQL is the only runtime database. SQLite and the VPS deployment are historical recovery material.
- Cloud Tasks must remain bounded at one concurrent dispatch and one dispatch per second unless a new bound is explicitly approved.
- Do not deploy `OPENAI_API_KEY`; production uses encrypted Codex OAuth through Pi AI.
- Do not print environment values, Telegram credentials, database URLs, OAuth state, encryption keys, or personal data.
- Historical Supabase migrations are immutable. Add forward migrations only.
- Use Jujutsu bookmarks and workspaces; do not create Git branch workflows.

## Production resources

Default region: `europe-west1`.

| Resource | Name | Production role |
|---|---|---|
| Cloud Run service | `jobseeker-web` | Public Telegram webhook and health endpoints |
| Cloud Run service | `jobseeker-worker` | Private Cloud Tasks worker |
| Cloud Run Job | `jobseeker-cycle` | Finite discovery/filtering/scoring cycle |
| Cloud Scheduler job | `jobseeker-cycle` | Sole production scrape schedule |
| Cloud Tasks queue | `jobseeker` | Telegram updates and bounded delivery work |
| Artifact Registry | `jobseeker` | Web and worker images |

The web service scales from zero to two instances at concurrency 20. The private worker scales from zero to three instances at concurrency 1. The cycle job has one task and parallelism one. The worker's external URL can return 404 because ingress is internal; validate it through Cloud Tasks and logs rather than public curl.

The retired VPS Jobseeker service and local production/test pollers should normally remain stopped.

## Shell setup

Run from the repository root:

```bash
cd /Users/uf90/work/jobseeker
export GCP_PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
export GCP_REGION="${GCP_REGION:-europe-west1}"
```

Confirm the selected project before any mutating command. Never infer the project from an old log or copied URL.

## Production status

Status checks must not change ownership.

### Local receivers and producers

```bash
pgrep -afil '/Users/uf90/work/(jobseeker|jobseeker-testbot)/dist/(server|worker|run-cycle)\.mjs' || true
```

A PID file is not authoritative. Confirm the process command before changing ownership.

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

Expected production ownership is Scheduler `ENABLED`, queue `RUNNING`, queue concurrency `1`, and dispatch rate `1.0`. During deployment or manual validation, Scheduler may intentionally be `PAUSED`.

### Public health and readiness

```bash
WEB_URL="$(gcloud run services describe jobseeker-web \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
curl -fsS --max-time 20 "$WEB_URL/health"
curl -fsS --max-time 30 "$WEB_URL/ready"
```

`/ready` must report PostgreSQL persistence.

### Telegram webhook without exposing credentials

Use the local token only to print redacted status fields:

```bash
node --env-file=.env - <<'NODE'
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
NODE
```

Do not print the webhook URL because it may contain routing information. Healthy production has a configured HTTPS webhook, zero or draining pending updates, and no current error.

### Retired VPS

The VPS is not a production owner. Its connection details are intentionally not stored in skills or documentation. Use locally managed SSH configuration only when ownership is unclear, and do not restart it during routine operations.

## Validation baseline

Use the package scripts. Do not use raw `bun test`: Bun automatically loads `.env`, while the package script runs the intended isolated Node test runner.

```bash
npm run typecheck
npm test
npm run build
npm run test:postgres
jj status
```

All four validation commands must pass before deployment. The PostgreSQL integration test uses temporary rows and cleans them up.

## Database migrations

1. Add a new timestamped SQL migration under `supabase/migrations/`.
2. Never edit a migration already applied remotely.
3. Review destructive statements and constraints before applying.
4. Apply the forward migration using the linked Supabase project and verify it before deploying dependent code.
5. Run `npm run test:postgres` after application.

Use the project's existing Supabase linkage and local secret files. Do not place database passwords on command lines or in logs.

## Release workflow

`scripts/deploy-gcp.sh` builds two images, deploys the worker, web service, and cycle job, then deliberately pauses Cloud Scheduler. It does not alter the Telegram webhook and does not execute a cycle.

### 1. Preflight ownership

- Confirm no local production poller or local scheduled producer is active.
- Confirm the VPS service is stopped if there is any doubt.
- Record the current ready web and worker revisions.
- Confirm the webhook is healthy.
- Confirm the task queue is bounded at `1/1`.
- Note whether Scheduler was enabled before deployment.

### 2. Validate and publish the commit

```bash
npm run typecheck
npm test
npm run build
npm run test:postgres
jj status
jj bookmark set cloud -r @
jj git push --bookmark cloud
```

Do not move `cloud` to an untested working copy. If the working copy contains unrelated changes, separate them before release.

### 3. Deploy

```bash
GCP_PROJECT_ID="$GCP_PROJECT_ID" GCP_REGION="$GCP_REGION" ./scripts/deploy-gcp.sh
```

The script reads `.env` and `.env.cloud` without uploading them, verifies Secret Manager versions, uses Cloud Build, and preserves bounded scaling. It pauses Scheduler even when production was previously enabled.

### 4. Validate staged revisions

```bash
WEB_URL="$(gcloud run services describe jobseeker-web \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
curl -fsS "$WEB_URL/health"
curl -fsS "$WEB_URL/ready"

gcloud scheduler jobs describe jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --format='value(state)'
```

Scheduler must be `PAUSED` at this point. Inspect errors for only the new revisions:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND (resource.labels.service_name="jobseeker-web" OR resource.labels.service_name="jobseeker-worker") AND severity>=ERROR' \
  --project="$GCP_PROJECT_ID" --freshness=30m --limit=100 \
  --format='value(timestamp,resource.labels.service_name,resource.labels.revision_name,severity,textPayload,jsonPayload.message)'
```

Redact any unexpected personal data before sharing output.

### 5. Run one controlled cycle

Keep Scheduler paused and ensure no local producer exists:

```bash
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

### 6. Restore scheduled ownership

Only after the controlled cycle succeeds:

```bash
gcloud scheduler jobs resume jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet
```

Then re-run the status checks. Verify exactly one receiver, Scheduler enabled, queue running at `1/1`, no local pollers, and a healthy webhook.

## Initial webhook configuration or ownership handoff

Normal deployments keep the same Cloud Run service URL, so the webhook does not need to be reset. Configure it only for initial cutover, token rotation, or an explicit return from local polling.

```bash
WEB_URL="$(gcloud run services describe jobseeker-web \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
TELEGRAM_WEBHOOK_URL="$WEB_URL/telegram/webhook" \
  bun --env-file=.env --env-file=.env.cloud src/scripts/set-telegram-webhook.ts
```

The script keeps pending updates and supplies the secret-token header. Before switching from polling to webhook, stop the poller and wait longer than the polling timeout. Resume Scheduler only after webhook and manual-cycle validation.

## Local testing

Prefer unit/integration tests and the separate test-bot workspace at `/Users/uf90/work/jobseeker-testbot`. It uses a different token and `RUN_JOBS=false`. Its `.env.test-bot` must remain ignored and mode `600`.

Do not start local polling with the production token for ordinary tests. If an explicit production rollback requires local polling:

1. Pause Cloud Scheduler.
2. Stop or redirect the Telegram webhook without dropping pending updates.
3. Wait longer than the previous receiver's polling/webhook transition interval.
4. Start exactly one local process with `TELEGRAM_MODE=polling`.
5. Verify its health and confirm no second receiver exists.
6. To return to cloud, stop local polling, wait for it to exit, configure the webhook, validate it, run a controlled cloud cycle, and resume Scheduler.

Never let local `RUN_JOBS=true` overlap enabled Cloud Scheduler.

## Logs and incident triage

### Recent web or worker errors

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="jobseeker-worker" AND severity>=ERROR' \
  --project="$GCP_PROJECT_ID" --freshness=1h --limit=100
```

Change the service filter to `jobseeker-web` when investigating webhook reception.

### Recent cycle executions

```bash
gcloud run jobs executions list --job=jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --limit=10
```

Use the execution name to constrain logs. Do not dump unrestricted production logs.

### Queue backlog

```bash
gcloud tasks list --queue=jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --format='table(name.basename(),scheduleTime,dispatchCount,responseCount)'
```

If tasks repeatedly fail, pause the queue before making destructive changes, inspect the private worker revision and OIDC/IAM configuration, deploy or roll back the worker, then resume the queue. Do not delete tasks merely to make the queue appear healthy.

## Rollback

Cloud Run keeps previous revisions. A failed new web revision should receive no traffic if it never became ready. If a ready revision is faulty:

1. Pause Scheduler.
2. Pause the task queue if worker processing is unsafe; keep it running for a web-only rollback when the worker is healthy.
3. Route the affected service back to its recorded last-known-good revision.
4. Redeploy the cycle job with the last-known-good worker image if cycle code changed.
5. Verify `/health`, `/ready`, webhook status, queue delivery, and error logs.
6. Run a controlled cycle if worker/cycle code changed.
7. Resume the queue and Scheduler only after validation.

Rollback uses PostgreSQL state already written by cloud revisions. Never roll back to a stale SQLite snapshot.

## Post-operation report

Report, without secrets or personal data:

- tested commit/bookmark;
- deployed ready revisions and cycle execution;
- `/health` and `/ready` result;
- Telegram webhook configured/pending/error booleans;
- Scheduler and queue state and bounds;
- local/VPS ownership state;
- controlled-cycle duration, discovery/normalization/scoring totals, task drain, and error count;
- any intentionally paused component or remaining follow-up.