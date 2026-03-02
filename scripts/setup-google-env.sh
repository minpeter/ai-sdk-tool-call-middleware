#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"
ENV_LOCAL_FILE="${ROOT_DIR}/.env.local"

is_tty=0
if [[ -t 0 ]]; then
  is_tty=1
fi

get_existing_value() {
  local key="$1"
  if [[ -f "${ENV_LOCAL_FILE}" ]]; then
    awk -F= -v key="${key}" '$1 == key {sub(/^[^=]*=/, "", $0); print $0; exit}' "${ENV_LOCAL_FILE}" \
      | sed -e "s/^'//" -e "s/'$//" || true
  fi
}

quote_env_value() {
  local value="$1"
  printf "'%s'" "$(printf "%s" "${value}" | sed "s/'/'\\\\''/g")"
}

prompt_value() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="${3:-}"
  local secret="${4:-0}"
  local required="${5:-1}"

  local current_value="${!var_name:-}"
  if [[ -z "${current_value}" ]]; then
    current_value="$(get_existing_value "${var_name}")"
  fi
  if [[ -z "${current_value}" ]]; then
    current_value="${default_value}"
  fi

  if [[ "${is_tty}" -eq 1 ]]; then
    local user_input=""
    if [[ "${secret}" == "1" ]]; then
      if [[ -n "${current_value}" ]]; then
        printf "%s [현재값 유지하려면 Enter]: " "${prompt_text}"
      else
        printf "%s: " "${prompt_text}"
      fi
      read -r -s user_input
      echo
    else
      if [[ -n "${current_value}" ]]; then
        printf "%s [%s]: " "${prompt_text}" "${current_value}"
      else
        printf "%s: " "${prompt_text}"
      fi
      read -r user_input
    fi

    if [[ -n "${user_input}" ]]; then
      current_value="${user_input}"
    fi
  fi

  if [[ "${required}" == "1" && -z "${current_value}" ]]; then
    echo "Missing required value: ${var_name}" >&2
    exit 1
  fi

  printf -v "${var_name}" "%s" "${current_value}"
}

ask_yes_no() {
  local prompt_text="$1"
  local default_yes="${2:-1}"
  local default_label="Y/n"
  if [[ "${default_yes}" == "0" ]]; then
    default_label="y/N"
  fi

  if [[ "${is_tty}" -eq 0 ]]; then
    if [[ "${default_yes}" == "1" ]]; then
      return 0
    fi
    return 1
  fi

  local answer=""
  printf "%s [%s]: " "${prompt_text}" "${default_label}"
  read -r answer
  answer="$(printf "%s" "${answer}" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "${answer}" ]]; then
    [[ "${default_yes}" == "1" ]]
    return
  fi

  [[ "${answer}" == "y" || "${answer}" == "yes" ]]
}

echo "[setup-google-env] writing ${ENV_EXAMPLE_FILE} and ${ENV_LOCAL_FILE}"

if [[ ! -f "${ENV_EXAMPLE_FILE}" ]]; then
  cat > "${ENV_EXAMPLE_FILE}" <<'EOF'
APP_ENV=dev
PORT=8080
LOG_LEVEL=info
HACKATHON_TRACK=social-good

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=
GEMINI_HTTP_TIMEOUT_MS=8000

# GCP
GCP_PROJECT_ID=
GCP_REGION=asia-northeast3
FIRESTORE_DATABASE=(default)
SERVICE_NAME_API=stagepilot-api
ARTIFACT_REPO=stagepilot

# Runtime constraints
USE_GPU=0
STAGEPILOT_REQUEST_BODY_TIMEOUT_MS=10000
PILOT_DISTRICT_1=강북구
PILOT_DISTRICT_2=중랑구
BENCHMARK_CASES=24
SLA_URGENT_MINUTES=120
SLA_NORMAL_HOURS=24

# OpenClaw (optional dispatch bridge)
OPENCLAW_ENABLED=0
OPENCLAW_CHANNEL=telegram
OPENCLAW_TARGET=
OPENCLAW_THREAD_ID=
OPENCLAW_WEBHOOK_URL=
OPENCLAW_API_KEY=
OPENCLAW_WEBHOOK_TIMEOUT_MS=5000
OPENCLAW_CMD=openclaw
OPENCLAW_CLI_TIMEOUT_MS=5000
EOF
fi

prompt_value APP_ENV "APP_ENV" "dev" 0 1
prompt_value PORT "PORT" "8080" 0 1
prompt_value LOG_LEVEL "LOG_LEVEL" "info" 0 1
prompt_value HACKATHON_TRACK "HACKATHON_TRACK" "social-good" 0 1

prompt_value GEMINI_API_KEY "GEMINI_API_KEY" "" 1 1
prompt_value GEMINI_MODEL "GEMINI_MODEL (AI Studio/Vertex에서 보이는 정확한 모델 ID)" "" 0 1
prompt_value GEMINI_HTTP_TIMEOUT_MS "GEMINI_HTTP_TIMEOUT_MS" "8000" 0 1

prompt_value GCP_PROJECT_ID "GCP_PROJECT_ID" "" 0 1
prompt_value GCP_REGION "GCP_REGION" "asia-northeast3" 0 1
prompt_value FIRESTORE_DATABASE "FIRESTORE_DATABASE" "(default)" 0 1
prompt_value SERVICE_NAME_API "SERVICE_NAME_API" "stagepilot-api" 0 1
prompt_value ARTIFACT_REPO "ARTIFACT_REPO" "stagepilot" 0 1

prompt_value USE_GPU "USE_GPU (고정: 0)" "0" 0 1
if [[ "${USE_GPU}" != "0" ]]; then
  echo "[setup-google-env] GPU is not allowed in this project; forcing USE_GPU=0"
  USE_GPU="0"
fi
prompt_value STAGEPILOT_REQUEST_BODY_TIMEOUT_MS "STAGEPILOT_REQUEST_BODY_TIMEOUT_MS" "10000" 0 1
prompt_value PILOT_DISTRICT_1 "PILOT_DISTRICT_1" "강북구" 0 1
prompt_value PILOT_DISTRICT_2 "PILOT_DISTRICT_2" "중랑구" 0 1
prompt_value BENCHMARK_CASES "BENCHMARK_CASES" "24" 0 1
prompt_value SLA_URGENT_MINUTES "SLA_URGENT_MINUTES" "120" 0 1
prompt_value SLA_NORMAL_HOURS "SLA_NORMAL_HOURS" "24" 0 1

prompt_value OPENCLAW_ENABLED "OPENCLAW_ENABLED (0/1)" "0" 0 1
prompt_value OPENCLAW_CHANNEL "OPENCLAW_CHANNEL" "telegram" 0 0
prompt_value OPENCLAW_TARGET "OPENCLAW_TARGET" "" 0 0
prompt_value OPENCLAW_THREAD_ID "OPENCLAW_THREAD_ID" "" 0 0
prompt_value OPENCLAW_WEBHOOK_URL "OPENCLAW_WEBHOOK_URL" "" 0 0
prompt_value OPENCLAW_API_KEY "OPENCLAW_API_KEY" "" 1 0
prompt_value OPENCLAW_WEBHOOK_TIMEOUT_MS "OPENCLAW_WEBHOOK_TIMEOUT_MS" "5000" 0 0
prompt_value OPENCLAW_CMD "OPENCLAW_CMD" "openclaw" 0 0
prompt_value OPENCLAW_CLI_TIMEOUT_MS "OPENCLAW_CLI_TIMEOUT_MS" "5000" 0 0

{
  echo "APP_ENV=$(quote_env_value "${APP_ENV}")"
  echo "PORT=$(quote_env_value "${PORT}")"
  echo "LOG_LEVEL=$(quote_env_value "${LOG_LEVEL}")"
  echo "HACKATHON_TRACK=$(quote_env_value "${HACKATHON_TRACK}")"
  echo
  echo "GEMINI_API_KEY=$(quote_env_value "${GEMINI_API_KEY}")"
  echo "GEMINI_MODEL=$(quote_env_value "${GEMINI_MODEL}")"
  echo "GEMINI_HTTP_TIMEOUT_MS=$(quote_env_value "${GEMINI_HTTP_TIMEOUT_MS}")"
  echo
  echo "GCP_PROJECT_ID=$(quote_env_value "${GCP_PROJECT_ID}")"
  echo "GCP_REGION=$(quote_env_value "${GCP_REGION}")"
  echo "FIRESTORE_DATABASE=$(quote_env_value "${FIRESTORE_DATABASE}")"
  echo "SERVICE_NAME_API=$(quote_env_value "${SERVICE_NAME_API}")"
  echo "ARTIFACT_REPO=$(quote_env_value "${ARTIFACT_REPO}")"
  echo
  echo "USE_GPU=$(quote_env_value "${USE_GPU}")"
  echo "STAGEPILOT_REQUEST_BODY_TIMEOUT_MS=$(quote_env_value "${STAGEPILOT_REQUEST_BODY_TIMEOUT_MS}")"
  echo "PILOT_DISTRICT_1=$(quote_env_value "${PILOT_DISTRICT_1}")"
  echo "PILOT_DISTRICT_2=$(quote_env_value "${PILOT_DISTRICT_2}")"
  echo "BENCHMARK_CASES=$(quote_env_value "${BENCHMARK_CASES}")"
  echo "SLA_URGENT_MINUTES=$(quote_env_value "${SLA_URGENT_MINUTES}")"
  echo "SLA_NORMAL_HOURS=$(quote_env_value "${SLA_NORMAL_HOURS}")"
  echo
  echo "OPENCLAW_ENABLED=$(quote_env_value "${OPENCLAW_ENABLED}")"
  echo "OPENCLAW_CHANNEL=$(quote_env_value "${OPENCLAW_CHANNEL}")"
  echo "OPENCLAW_TARGET=$(quote_env_value "${OPENCLAW_TARGET}")"
  echo "OPENCLAW_THREAD_ID=$(quote_env_value "${OPENCLAW_THREAD_ID}")"
  echo "OPENCLAW_WEBHOOK_URL=$(quote_env_value "${OPENCLAW_WEBHOOK_URL}")"
  echo "OPENCLAW_API_KEY=$(quote_env_value "${OPENCLAW_API_KEY}")"
  echo "OPENCLAW_WEBHOOK_TIMEOUT_MS=$(quote_env_value "${OPENCLAW_WEBHOOK_TIMEOUT_MS}")"
  echo "OPENCLAW_CMD=$(quote_env_value "${OPENCLAW_CMD}")"
  echo "OPENCLAW_CLI_TIMEOUT_MS=$(quote_env_value "${OPENCLAW_CLI_TIMEOUT_MS}")"
} > "${ENV_LOCAL_FILE}"

chmod 600 "${ENV_LOCAL_FILE}"

echo "[setup-google-env] .env.local written"
echo "[setup-google-env] validating required values..."

set -a
# shellcheck source=/dev/null
source "${ENV_LOCAL_FILE}"
set +a

[[ -n "${GEMINI_API_KEY:-}" ]] || { echo "GEMINI_API_KEY missing after write" >&2; exit 1; }
[[ -n "${GCP_PROJECT_ID:-}" ]] || { echo "GCP_PROJECT_ID missing after write" >&2; exit 1; }
[[ "${USE_GPU:-1}" == "0" ]] || { echo "USE_GPU must be 0" >&2; exit 1; }
[[ -n "${SERVICE_NAME_API:-}" ]] || { echo "SERVICE_NAME_API missing after write" >&2; exit 1; }
[[ -n "${ARTIFACT_REPO:-}" ]] || { echo "ARTIFACT_REPO missing after write" >&2; exit 1; }

echo "[setup-google-env] local env validation OK"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "[setup-google-env] gcloud not found; skipping GCP automation."
  echo "  Install: https://cloud.google.com/sdk/docs/install"
  exit 0
fi

run_gcloud_setup=1
if [[ -n "${SETUP_GCLOUD:-}" ]]; then
  if [[ "${SETUP_GCLOUD}" == "1" ]]; then
    run_gcloud_setup=1
  else
    run_gcloud_setup=0
  fi
elif ! ask_yes_no "Run gcloud project/service/secret setup now?" 1; then
  run_gcloud_setup=0
fi

if [[ "${run_gcloud_setup}" == "0" ]]; then
  echo "[setup-google-env] gcloud setup skipped."
  exit 0
fi

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
if [[ -z "${active_account}" ]]; then
  echo "[setup-google-env] no active gcloud account found. Starting login..."
  gcloud auth login
fi

echo "[setup-google-env] setting gcloud project: ${GCP_PROJECT_ID}"
gcloud config set project "${GCP_PROJECT_ID}" >/dev/null

echo "[setup-google-env] enabling required GCP services..."
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com >/dev/null

if gcloud secrets describe gemini-api-key --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  printf "%s" "${GEMINI_API_KEY}" | gcloud secrets versions add gemini-api-key --data-file=- >/dev/null
  echo "[setup-google-env] secret version added: gemini-api-key"
else
  printf "%s" "${GEMINI_API_KEY}" | gcloud secrets create gemini-api-key --data-file=- >/dev/null
  echo "[setup-google-env] secret created: gemini-api-key"
fi

gcloud secrets versions access latest --secret=gemini-api-key >/dev/null
echo "[setup-google-env] secret verification OK"
echo "[setup-google-env] done"
