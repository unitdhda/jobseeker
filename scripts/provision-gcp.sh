#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID to a billing-enabled Google Cloud project.}"
GCP_REGION="${GCP_REGION:-europe-west1}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-jobseeker}"
CLOUD_TASKS_QUEUE="${CLOUD_TASKS_QUEUE:-jobseeker}"

command -v gcloud >/dev/null || { echo 'gcloud is required.' >&2; exit 1; }
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || { echo 'Authenticate gcloud first.' >&2; exit 1; }
gcloud billing projects describe "$GCP_PROJECT_ID" --format='value(billingEnabled)' | grep -qx True || {
  echo 'The selected GCP project must have billing enabled.' >&2; exit 1;
}
gcloud config set project "$GCP_PROJECT_ID" >/dev/null

gcloud services enable \
  artifactregistry.googleapis.com cloudbuild.googleapis.com cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com iamcredentials.googleapis.com run.googleapis.com secretmanager.googleapis.com

service_account() {
  local name="$1" description="$2"
  gcloud iam service-accounts describe "$name@$GCP_PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$name" --display-name="$description"
}
service_account jobseeker-web 'Jobseeker public webhook'
service_account jobseeker-worker 'Jobseeker private task worker'
service_account jobseeker-cycle 'Jobseeker singleton cycle job'
service_account jobseeker-tasks 'Jobseeker Cloud Tasks OIDC identity'
service_account jobseeker-scheduler 'Jobseeker Cloud Scheduler identity'

WEB_SA="jobseeker-web@$GCP_PROJECT_ID.iam.gserviceaccount.com"
CYCLE_SA="jobseeker-cycle@$GCP_PROJECT_ID.iam.gserviceaccount.com"
TASKS_SA="jobseeker-tasks@$GCP_PROJECT_ID.iam.gserviceaccount.com"
for principal in "$WEB_SA" "$CYCLE_SA"; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member="serviceAccount:$principal" \
    --role=roles/cloudtasks.enqueuer --condition=None >/dev/null
  gcloud iam service-accounts add-iam-policy-binding "$TASKS_SA" --member="serviceAccount:$principal" \
    --role=roles/iam.serviceAccountUser --condition=None >/dev/null
done
if ! gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" --location="$GCP_REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" --location="$GCP_REGION" \
    --repository-format=docker --description='Jobseeker container images'
fi
if ! gcloud tasks queues describe "$CLOUD_TASKS_QUEUE" --location="$GCP_REGION" >/dev/null 2>&1; then
  gcloud tasks queues create "$CLOUD_TASKS_QUEUE" --location="$GCP_REGION"
fi
gcloud tasks queues update "$CLOUD_TASKS_QUEUE" --location="$GCP_REGION" \
  --max-dispatches-per-second=3 --max-concurrent-dispatches=3 --max-attempts=10 \
  --min-backoff=5s --max-backoff=300s --max-doublings=5 >/dev/null

for secret in database-url telegram-bot-token telegram-webhook-secret task-execution-secret \
  supabase-secret-key runtime-state-encryption-key; do
  gcloud secrets describe "jobseeker-$secret" >/dev/null 2>&1 ||
    gcloud secrets create "jobseeker-$secret" --replication-policy=automatic
done
secret_access() {
  local secret="$1" principal="$2"
  gcloud secrets add-iam-policy-binding "jobseeker-$secret" --member="serviceAccount:$principal" \
    --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
}
for secret in database-url telegram-bot-token telegram-webhook-secret task-execution-secret; do
  secret_access "$secret" "$WEB_SA"
done
for secret in database-url telegram-bot-token task-execution-secret supabase-secret-key runtime-state-encryption-key; do
  secret_access "$secret" "jobseeker-worker@$GCP_PROJECT_ID.iam.gserviceaccount.com"
done
for secret in database-url task-execution-secret supabase-secret-key runtime-state-encryption-key; do
  secret_access "$secret" "$CYCLE_SA"
done

echo "GCP base resources are ready in $GCP_PROJECT_ID/$GCP_REGION."
echo 'Next: seed secret versions with scripts/seed-gcp-secrets.mjs, then run scripts/deploy-gcp.sh.'
