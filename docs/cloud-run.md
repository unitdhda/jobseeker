# Cloud Run staging and cutover

> **This surface is deployed and idle.** Production runs on a VPS — see [VPS deployment](vps-claude-bridge.md).
> Cloud Scheduler is `PAUSED` and no Telegram webhook points here. Everything below describes the staged
> alternative and what a cutover back to it would involve.

The cloud deployment uses separate web and worker images in five bounded roles:

| Role | Runtime | Bounds |
|---|---|---|
| Public Telegram webhook | Cloud Run service | 1 CPU, 512 MiB, concurrency 20, maximum 2 instances |
| Private task worker | Cloud Run service | 2 CPU, 2 GiB, concurrency 1, maximum 3 instances |
| Scrape/score cycle | Cloud Run Job | one task, 2 CPU, 2 GiB, 30-minute timeout |
| Profile repair | Cloud Run Job | one task, 2 CPU, 2 GiB, 30-minute timeout; manually invoked |
| Schedule | Cloud Scheduler | one paused schedule invoking only the cycle job |

Cloud Tasks is limited to one concurrent and one dispatched request per second. The scrape cycle uses a PostgreSQL advisory lock
and bounded user/platform concurrency; HH browser work remains serialized and each HH search has a hard deadline. The
profile-repair job only fills missing or invalid profiles and has no schedule. Cloud Tasks provides delivery retries. These are hard workload bounds; a Google Cloud budget is only
an alert and is not a hard billing cutoff.

## Prerequisites

1. Install the Google Cloud CLI and authenticate it without committing its credential files.
2. Select or create a billing-enabled project.
3. Keep `.env` and `.env.cloud` mode `600`; neither file is uploaded by Cloud Build.
4. Keep the four local font files under `fonts/`. They are sent to the private container build but remain excluded from Git.

```bash
gcloud auth login
export GCP_PROJECT_ID='your-project-id'
export GCP_REGION='europe-west1'
```

The deployment deliberately does not supply `OPENAI_API_KEY`, so paid fallback remains disabled.

## Provision bounded resources

```bash
GCP_PROJECT_ID="$GCP_PROJECT_ID" GCP_REGION="$GCP_REGION" ./scripts/provision-gcp.sh
```

This enables the required APIs; creates least-privilege runtime identities, Artifact Registry, Cloud Tasks, and six Secret Manager secrets; and caps the task queue. It does not create secret versions or deploy workloads.

## Seed secrets

The seeder reads values without printing them. It keeps existing enabled versions unless `ROTATE_GCP_SECRETS=true` is explicitly set. `TASK_EXECUTION_SECRET` is generated when absent locally.

```bash
GCP_PROJECT_ID="$GCP_PROJECT_ID" \
  bun --env-file=.env --env-file=.env.cloud scripts/seed-gcp-secrets.mjs
```

Do not rotate the task execution secret while tasks are in flight. New Cloud Run revisions must be deployed after any rotation.

## Build and stage

```bash
GCP_PROJECT_ID="$GCP_PROJECT_ID" GCP_REGION="$GCP_REGION" ./scripts/deploy-gcp.sh
```

The script builds remotely, deploys bounded services plus the cycle and profile-repair jobs, grants only the task OIDC identity
access to the worker, and creates the Cloud Scheduler job in a **paused** state. It does not configure Telegram and does not execute
either job.

Check the public service and PostgreSQL connectivity:

```bash
WEB_URL="$(gcloud run services describe jobseeker-web --region="$GCP_REGION" --format='value(status.url)')"
curl -fsS "$WEB_URL/health"
curl -fsS "$WEB_URL/ready"
gcloud scheduler jobs describe jobseeker-cycle --location="$GCP_REGION" \
  --format='value(state)'
```

Expected persistence is `postgres`, and Scheduler must report `PAUSED`.

## Validation before cutover

Do not point Telegram at Cloud Run or run the cloud cycle while the local poller is active. Before cutover, validate:

- Webhook service has minimum zero and maximum two instances.
- Worker is private, has minimum zero, maximum three, and concurrency one.
- Task queue rate and concurrency are both one.
- Scheduler is paused.
- `/ready` connects to Supabase.
- Encrypted OAuth and HH browser state still exist in the private bucket.
- No paid API key is present in any Cloud Run revision.

## Cutover order

This takes Telegram and the schedule away from whatever owns them now — today the VPS. See the handoff sequence in
`docs/operations.md`.

1. Keep Scheduler paused.
2. Stop the current receiver — the VPS bot, or a local poller — and verify that its process has exited.
3. Confirm the seven-table PostgreSQL schema and row-count parity.
4. Persist current OAuth and HH browser state.
5. Configure Telegram to use the public `/telegram/webhook` URL with `drop_pending_updates=false`.
6. Test `/start`, one inexpensive command, and one controlled task.
7. Execute the profile-repair job when users with CVs have missing profiles, and verify its summary reports zero failures.
8. Execute one cycle job manually and inspect logs, advisory locking, memory, and deliveries.
9. Unpause Scheduler only after the manual cycle succeeds.

Rollback after cloud writes should use local polling against PostgreSQL. Do not resume from the stale SQLite snapshot.
