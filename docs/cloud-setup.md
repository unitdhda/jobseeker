# Cloud setup and manual control

How the **cloud** deployment fits together, and how to turn it on, pause it, or stop it by hand.

> Production currently runs on a VPS, not here. Cloud Scheduler is
> `PAUSED` and no Telegram webhook points at Cloud Run, so nothing in this file is running on a schedule today.

For the full release, validation, triage, and rollback procedures, see `docs/operations.md`. This file covers only the
shape of the cloud system and its three control surfaces. The `bun` invocations below also run under Node.js 24+
(substitute `node`; add `--experimental-transform-types` for `.ts` entrypoints).

## Shell setup

Run from the repository root.

```bash
export GCP_PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
export GCP_REGION="${GCP_REGION:-europe-west1}"
```

Confirm the project before any mutating command.

## What runs where

| Resource | Name | Role |
|---|---|---|
| Cloud Scheduler job | `jobseeker-cycle` | Triggers the cycle every 30 minutes (`*/30 * * * *`, Europe/Moscow) |
| Cloud Run Job | `jobseeker-cycle` | One finite scrape → normalize → prefilter → score run, then exits |
| Cloud Run Job | `jobseeker-profile-refresh` | Manual repair of missing CV-derived profiles; never scheduled |
| Cloud Run service | `jobseeker-web` | Public; receives the Telegram webhook and serves `/health`, `/ready` |
| Cloud Run service | `jobseeker-worker` | Private; executes Cloud Tasks (Telegram updates, alerts, digests) |
| Cloud Tasks queue | `jobseeker` | Bounded pipe between web/cycle and the worker (1 concurrent, 1/sec) |

Nothing runs continuously. Both services scale to zero, and the cycle job is a container that starts, works, and exits.

## How a cycle flows

1. Scheduler POSTs to the Cloud Run Jobs API with an OAuth token (180s attempt deadline, 3 retries).
2. The cycle job restores encrypted HH browser state from Supabase storage.
3. It takes a PostgreSQL advisory lock. If another cycle holds it, this one logs and exits — a guard, not a scheduler.
4. It scrapes all `(user, platform)` pairs concurrently; HH stays serialized in one reused Chromium context with a
   180s per-operation deadline. Each platform searches one rotating query variant per cycle.
5. It normalizes selected candidates, prefilters them lexically, and scores the survivors through Pi AI.
6. It enqueues due alert and digest work into Cloud Tasks (`BACKGROUND_DELIVERY_ASYNC=true`), persists browser state,
   and exits 0.
7. The queue dispatches to the private worker one at a time, which sends the Telegram messages.

Inbound Telegram traffic is a separate path: Telegram → `jobseeker-web` → Cloud Tasks → `jobseeker-worker`.

## The three control surfaces

Ownership is determined by exactly three switches. Everything else is passive infrastructure.

| Switch | Controls | Healthy production value |
|---|---|---|
| Cloud Scheduler `jobseeker-cycle` | Whether cycles run | `ENABLED` |
| Telegram webhook | Whether user messages arrive | Configured, HTTPS, no error |
| Cloud Tasks queue `jobseeker` | Whether deliveries and updates are processed | `RUNNING`, `1`/`1.0` |

## Check current state

None of these change anything.

```bash
gcloud scheduler jobs describe jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --format='value(state,schedule,timeZone)'

gcloud tasks queues describe jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --format='value(state,rateLimits.maxConcurrentDispatches,rateLimits.maxDispatchesPerSecond)'

WEB_URL="$(gcloud run services describe jobseeker-web \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
curl -fsS --max-time 30 "$WEB_URL/ready"
```

Also confirm nothing else is competing for the same Telegram token or schedule — including the VPS, which owns
production today:

```bash
pgrep -afil 'dist/(server|worker|run-cycle)\.mjs' || true
vps 'docker ps --format "{{.Names}} {{.Status}}"'
```

`vps` is the helper defined in `docs/operations.md`; host connection details live in local configuration only.

## Pause

Temporary stop that keeps everything configured. Use during deploys, manual cycles, and investigation.

```bash
gcloud scheduler jobs pause jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet
```

The webhook stays live, so users can still talk to the bot; only scheduled scraping stops. Pending alerts and digests
accumulate in PostgreSQL and are delivered by the next cycle that runs.

If the worker itself is misbehaving, also pause the queue so tasks stop being dispatched but are not lost:

```bash
gcloud tasks queues pause jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet
```

## Enable

Hand production ownership to Cloud Run. Do this only after a controlled cycle has succeeded, and only after the
current owner — today the VPS bot — has been stopped. See the handoff sequence in `docs/operations.md`.

```bash
gcloud tasks queues resume jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet   # only if it was paused

gcloud scheduler jobs resume jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet
```

If the webhook was removed, or the token or web URL changed, point Telegram back at the service:

```bash
WEB_URL="$(gcloud run services describe jobseeker-web \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
TELEGRAM_WEBHOOK_URL="$WEB_URL/telegram/webhook" \
  bun --env-file=.env --env-file=.env.cloud src/scripts/set-telegram-webhook.ts
```

Stop the VPS bot or any local poller and wait longer than its polling timeout first. Two receivers on one token
silently lose updates.

Then re-run the state checks above.

## Disable

Full stop without deleting anything. State stays in PostgreSQL and resumes cleanly.

```bash
gcloud scheduler jobs pause jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet

gcloud tasks queues pause jobseeker \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet

bun --env-file=.env - <<'BUN'
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteWebhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ drop_pending_updates: false }),
});
if (!(await response.json()).ok) throw new Error('Telegram webhook removal failed.');
console.log('Webhook removed; pending updates retained.');
BUN
```

Keep `drop_pending_updates: false` so queued user messages survive. The Cloud Run services stay deployed and simply
receive no traffic; they cost nothing at zero instances. Reverse with the Enable steps.

## Run one cycle by hand

Keep Scheduler paused to guarantee a single producer — and stop the VPS bot first if it is running. The advisory
lock keeps two cycles from scraping at once, but **delivery is not locked**, so a second producer sends real users
duplicate alerts and digests:

```bash
gcloud run jobs execute jobseeker-cycle \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --wait
```

Follow a named execution:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="EXECUTION_NAME"' \
  --project="$GCP_PROJECT_ID" --limit=100 --order=asc \
  --format='value(timestamp,textPayload)'
```

A healthy run ends with `Vacancy cycle complete`, a `Queued N delivery tasks` line, and `Container called exit(0)`.

To repair users whose CV produced no search profiles:

```bash
gcloud run jobs execute jobseeker-profile-refresh \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --wait
```

## Deploying

`scripts/deploy-gcp.sh` builds both images and updates the services and jobs. It deliberately leaves Scheduler
**paused** and does not touch the Telegram webhook, so cutover is always an explicit decision. After deploying, run one
manual cycle, verify it, then Enable.
