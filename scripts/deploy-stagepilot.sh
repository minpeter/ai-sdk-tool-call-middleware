#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Auto-add local gcloud installation path when available.
if [[ -d "${HOME}/.local/google-cloud-sdk/bin" ]]; then
  export PATH="${HOME}/.local/google-cloud-sdk/bin:${PATH}"
fi

if [[ -f ".env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

need_cmd gcloud

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:=asia-northeast3}"
: "${SERVICE_NAME_API:=stagepilot-api}"
: "${GEMINI_MODEL:=gemini-3.1-pro-preview}"
: "${GEMINI_HTTP_TIMEOUT_MS:=8000}"
: "${STAGEPILOT_REQUEST_BODY_TIMEOUT_MS:=10000}"
: "${FIRESTORE_DATABASE:=(default)}"
: "${HACKATHON_TRACK:=social-good}"
: "${PILOT_DISTRICT_1:=강북구}"
: "${PILOT_DISTRICT_2:=중랑구}"
: "${SLA_URGENT_MINUTES:=120}"
: "${SLA_NORMAL_HOURS:=24}"
: "${BENCHMARK_CASES:=24}"
: "${USE_GPU:=0}"

if [[ "${USE_GPU}" != "0" ]]; then
  echo "USE_GPU must be 0 for this project." >&2
  exit 1
fi

RUNTIME_SA="${RUNTIME_SA:-stagepilot-runner@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"

echo "[deploy-stagepilot] project=${GCP_PROJECT_ID}"
echo "[deploy-stagepilot] region=${GCP_REGION}"
echo "[deploy-stagepilot] service=${SERVICE_NAME_API}"
echo "[deploy-stagepilot] runtime_sa=${RUNTIME_SA}"
echo "[deploy-stagepilot] model=${GEMINI_MODEL}"
echo "[deploy-stagepilot] gemini_timeout_ms=${GEMINI_HTTP_TIMEOUT_MS}"
echo "[deploy-stagepilot] request_body_timeout_ms=${STAGEPILOT_REQUEST_BODY_TIMEOUT_MS}"

gcloud run deploy "${SERVICE_NAME_API}" \
  --source . \
  --project "${GCP_PROJECT_ID}" \
  --region "${GCP_REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "${RUNTIME_SA}" \
  --port 8080 \
  --cpu 1 \
  --memory 1Gi \
  --min-instances 0 \
  --max-instances 3 \
  --execution-environment gen2 \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest" \
  --set-env-vars "APP_ENV=prod,LOG_LEVEL=info,USE_GPU=0,GEMINI_MODEL=${GEMINI_MODEL},GEMINI_HTTP_TIMEOUT_MS=${GEMINI_HTTP_TIMEOUT_MS},STAGEPILOT_REQUEST_BODY_TIMEOUT_MS=${STAGEPILOT_REQUEST_BODY_TIMEOUT_MS},FIRESTORE_DATABASE=${FIRESTORE_DATABASE},HACKATHON_TRACK=${HACKATHON_TRACK},PILOT_DISTRICT_1=${PILOT_DISTRICT_1},PILOT_DISTRICT_2=${PILOT_DISTRICT_2},SLA_URGENT_MINUTES=${SLA_URGENT_MINUTES},SLA_NORMAL_HOURS=${SLA_NORMAL_HOURS},BENCHMARK_CASES=${BENCHMARK_CASES}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME_API}" \
  --project "${GCP_PROJECT_ID}" \
  --region "${GCP_REGION}" \
  --format='value(status.url)')"

echo "[deploy-stagepilot] deployed_url=${SERVICE_URL}"
echo "[deploy-stagepilot] health_check: curl -s ${SERVICE_URL}/health | jq"
