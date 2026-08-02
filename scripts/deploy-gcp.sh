#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID.}"
GCP_REGION="${GCP_REGION:-europe-west1}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-jobseeker}"
CLOUD_TASKS_QUEUE="${CLOUD_TASKS_QUEUE:-jobseeker}"
WEB_SERVICE="${WEB_SERVICE:-jobseeker-web}"
WORKER_SERVICE="${WORKER_SERVICE:-jobseeker-worker}"
CYCLE_JOB="${CYCLE_JOB:-jobseeker-cycle}"
CYCLE_SCHEDULE="${CYCLE_SCHEDULE:-*/30 * * * *}"
CYCLE_TIMEZONE="${CYCLE_TIMEZONE:-Europe/Moscow}"

command -v gcloud >/dev/null || { echo 'gcloud is required.' >&2; exit 1; }
for file in .env .env.cloud fonts/Spectral-Regular.ttf fonts/Spectral-Bold.ttf \
  fonts/PragmataPro_Mono_R_liga_0903.ttf fonts/PragmataProR_liga_0903.ttf; do
  [ -f "$file" ] || { echo "$file is required." >&2; exit 1; }
done
plain_env() {
  node --env-file=.env --env-file=.env.cloud -e "const value=process.env[process.argv[1]];if(!value)process.exit(2);process.stdout.write(value)" "$1"
}
SUPABASE_URL_VALUE="$(plain_env SUPABASE_URL)"
SUPABASE_BUCKET_VALUE="$(plain_env SUPABASE_STORAGE_BUCKET)"
TELEGRAM_USER_ID_VALUE="$(plain_env TELEGRAM_USER_ID)"
TASKS_SA="jobseeker-tasks@$GCP_PROJECT_ID.iam.gserviceaccount.com"
WORKER_SA="jobseeker-worker@$GCP_PROJECT_ID.iam.gserviceaccount.com"
WEB_SA="jobseeker-web@$GCP_PROJECT_ID.iam.gserviceaccount.com"
CYCLE_SA="jobseeker-cycle@$GCP_PROJECT_ID.iam.gserviceaccount.com"
SCHEDULER_SA="jobseeker-scheduler@$GCP_PROJECT_ID.iam.gserviceaccount.com"

for secret in database-url telegram-bot-token telegram-webhook-secret task-execution-secret \
  supabase-secret-key runtime-state-encryption-key; do
  gcloud secrets versions list "jobseeker-$secret" --project="$GCP_PROJECT_ID" --filter=state=ENABLED \
    --format='value(name)' | grep -q . || { echo "jobseeker-$secret has no enabled version." >&2; exit 1; }
done

if [ -n "${GCP_IMAGE:-}" ]; then
  WEB_IMAGE="${GCP_WEB_IMAGE:-$GCP_IMAGE}"
  WORKER_IMAGE="${GCP_WORKER_IMAGE:-$GCP_IMAGE}"
else
  TAG="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
  WEB_IMAGE="${GCP_WEB_IMAGE:-$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REPOSITORY/jobseeker-web:$TAG}"
  WORKER_IMAGE="${GCP_WORKER_IMAGE:-$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REPOSITORY/jobseeker-worker:$TAG}"
  gcloud builds submit --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --config=cloudbuild.yaml \
    --substitutions="_WEB_IMAGE=$WEB_IMAGE,_WORKER_IMAGE=$WORKER_IMAGE" .
fi

COMMON_SECRETS="DATABASE_URL=jobseeker-database-url:latest,SUPABASE_SECRET_KEY=jobseeker-supabase-secret-key:latest,RUNTIME_STATE_ENCRYPTION_KEY=jobseeker-runtime-state-encryption-key:latest"
WORKER_SECRETS="$COMMON_SECRETS,TELEGRAM_BOT_TOKEN=jobseeker-telegram-bot-token:latest,TASK_EXECUTION_SECRET=jobseeker-task-execution-secret:latest"
COMMON_ENV="POSTGRES_POOL_MAX=4,POSTGRES_SSL=require,SUPABASE_URL=$SUPABASE_URL_VALUE,SUPABASE_STORAGE_BUCKET=$SUPABASE_BUCKET_VALUE,HH_BROWSER_DATA_PATH=/tmp/hh-browser,TYPST_FONT_PATHS=/app/fonts"

gcloud run deploy "$WORKER_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --image="$WORKER_IMAGE" \
  --service-account="$WORKER_SA" --command=node --args=dist/task-worker.mjs --port=3000 \
  --cpu=2 --memory=2Gi --concurrency=1 --min-instances=0 --max-instances=3 --timeout=1800 \
  --execution-environment=gen2 --ingress=internal --no-allow-unauthenticated \
  --set-env-vars="$COMMON_ENV,RUN_JOBS=false,RUN_INITIAL_CYCLE=false,TELEGRAM_MODE=webhook,TELEGRAM_USER_ID=$TELEGRAM_USER_ID_VALUE" \
  --set-secrets="$WORKER_SECRETS" --quiet
WORKER_URL="$(gcloud run services describe "$WORKER_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
gcloud run services add-iam-policy-binding "$WORKER_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
  --member="serviceAccount:$TASKS_SA" --role=roles/run.invoker --condition=None >/dev/null

TASK_ENV="CLOUD_TASKS_PROJECT=$GCP_PROJECT_ID,CLOUD_TASKS_LOCATION=$GCP_REGION,CLOUD_TASKS_QUEUE=$CLOUD_TASKS_QUEUE,CLOUD_TASKS_WORKER_URL=$WORKER_URL,CLOUD_TASKS_AUDIENCE=$WORKER_URL,CLOUD_TASKS_SERVICE_ACCOUNT=$TASKS_SA"
gcloud run deploy "$WEB_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --image="$WEB_IMAGE" \
  --service-account="$WEB_SA" --port=3000 --cpu=1 --memory=512Mi --concurrency=20 \
  --min-instances=0 --max-instances=2 --timeout=30 --execution-environment=gen2 --ingress=all --allow-unauthenticated \
  --set-env-vars="POSTGRES_POOL_MAX=4,POSTGRES_SSL=require,RUN_JOBS=false,RUN_INITIAL_CYCLE=false,TELEGRAM_MODE=webhook,TELEGRAM_USER_ID=$TELEGRAM_USER_ID_VALUE,TELEGRAM_WEBHOOK_ASYNC=true,$TASK_ENV" \
  --set-secrets="DATABASE_URL=jobseeker-database-url:latest,TELEGRAM_BOT_TOKEN=jobseeker-telegram-bot-token:latest,TELEGRAM_WEBHOOK_SECRET=jobseeker-telegram-webhook-secret:latest,TASK_EXECUTION_SECRET=jobseeker-task-execution-secret:latest" --quiet

gcloud run jobs deploy "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --image="$WORKER_IMAGE" \
  --service-account="$CYCLE_SA" --command=node --args=dist/run-cycle.mjs --cpu=1 --memory=2Gi \
  --tasks=1 --parallelism=1 --max-retries=1 --task-timeout=1800s \
  --set-env-vars="$COMMON_ENV,RUN_JOBS=false,RUN_INITIAL_CYCLE=false,TELEGRAM_MODE=off,BACKGROUND_DELIVERY_ASYNC=true,$TASK_ENV" \
  --set-secrets="$COMMON_SECRETS,TASK_EXECUTION_SECRET=jobseeker-task-execution-secret:latest" --quiet
gcloud run jobs add-iam-policy-binding "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
  --member="serviceAccount:$SCHEDULER_SA" --role=roles/run.invoker >/dev/null

RUN_URI="https://run.googleapis.com/v2/projects/$GCP_PROJECT_ID/locations/$GCP_REGION/jobs/$CYCLE_JOB:run"
if gcloud scheduler jobs describe "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --location="$GCP_REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs pause "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet || true
else
  # Create with a dormant annual schedule, then pause before applying the real cron to avoid a boundary-time race.
  gcloud scheduler jobs create http "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
    --schedule='0 0 1 1 *' --time-zone=Etc/UTC --uri="$RUN_URI" --http-method=POST \
    --oauth-service-account-email="$SCHEDULER_SA" --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
    --headers=Content-Type=application/json --message-body='{}' --attempt-deadline=180s --quiet
  gcloud scheduler jobs pause "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet
fi
gcloud scheduler jobs update http "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --location="$GCP_REGION" \
  --schedule="$CYCLE_SCHEDULE" --time-zone="$CYCLE_TIMEZONE" --uri="$RUN_URI" --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SA" --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
  --update-headers=Content-Type=application/json --message-body='{}' --attempt-deadline=180s \
  --max-retry-attempts=3 --min-backoff=30s --max-backoff=300s --quiet
gcloud scheduler jobs pause "$CYCLE_JOB" --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --quiet || true
# Keep cutover explicit: deploys do not configure Telegram or run the cycle automatically.
echo "Web image: $WEB_IMAGE"
echo "Worker image: $WORKER_IMAGE"
echo "Webhook service: $(gcloud run services describe "$WEB_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"
echo "Worker service: $WORKER_URL"
echo "Cycle Scheduler is configured; pause it until cutover with: gcloud scheduler jobs pause $CYCLE_JOB --location=$GCP_REGION --project=$GCP_PROJECT_ID"
