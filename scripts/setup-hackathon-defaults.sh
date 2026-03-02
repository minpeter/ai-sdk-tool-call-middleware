#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Fixed defaults for this hackathon project.
export APP_ENV="${APP_ENV:-dev}"
export PORT="${PORT:-8080}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export HACKATHON_TRACK="${HACKATHON_TRACK:-social-good}"
export GEMINI_HTTP_TIMEOUT_MS="${GEMINI_HTTP_TIMEOUT_MS:-8000}"

export GCP_REGION="${GCP_REGION:-asia-northeast3}"
export FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"
export SERVICE_NAME_API="${SERVICE_NAME_API:-stagepilot-api}"
export ARTIFACT_REPO="${ARTIFACT_REPO:-stagepilot}"

export USE_GPU=0
export STAGEPILOT_REQUEST_BODY_TIMEOUT_MS="${STAGEPILOT_REQUEST_BODY_TIMEOUT_MS:-10000}"
export PILOT_DISTRICT_1="${PILOT_DISTRICT_1:-강북구}"
export PILOT_DISTRICT_2="${PILOT_DISTRICT_2:-중랑구}"
export BENCHMARK_CASES="${BENCHMARK_CASES:-24}"
export SLA_URGENT_MINUTES="${SLA_URGENT_MINUTES:-120}"
export SLA_NORMAL_HOURS="${SLA_NORMAL_HOURS:-24}"

export OPENCLAW_ENABLED="${OPENCLAW_ENABLED:-0}"
export OPENCLAW_CHANNEL="${OPENCLAW_CHANNEL:-telegram}"
export OPENCLAW_TARGET="${OPENCLAW_TARGET:-}"
export OPENCLAW_THREAD_ID="${OPENCLAW_THREAD_ID:-}"
export OPENCLAW_WEBHOOK_URL="${OPENCLAW_WEBHOOK_URL:-}"
export OPENCLAW_API_KEY="${OPENCLAW_API_KEY:-}"
export OPENCLAW_WEBHOOK_TIMEOUT_MS="${OPENCLAW_WEBHOOK_TIMEOUT_MS:-5000}"
export OPENCLAW_CMD="${OPENCLAW_CMD:-openclaw}"
export OPENCLAW_CLI_TIMEOUT_MS="${OPENCLAW_CLI_TIMEOUT_MS:-5000}"

echo "[setup-hackathon-defaults] fixed defaults loaded."
echo "[setup-hackathon-defaults] you only need to enter missing required values:"
echo "  - GEMINI_API_KEY"
echo "  - GEMINI_MODEL"
echo "  - GCP_PROJECT_ID"

bash "${ROOT_DIR}/scripts/setup-google-env.sh"
