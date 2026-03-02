#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${STAGEPILOT_BASE_URL:-http://127.0.0.1:8080}}"
AUTO_START="${STAGEPILOT_SMOKE_AUTO_START:-1}"
CURL_MAX_TIME="${STAGEPILOT_SMOKE_CURL_MAX_TIME:-20}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${STAGEPILOT_API_START_CMD:-}" ]]; then
  API_START_CMD="${STAGEPILOT_API_START_CMD}"
elif [[ -f "${ROOT_DIR}/.env.local" ]]; then
  API_START_CMD="cd \"${ROOT_DIR}\" && set -a && . ./.env.local && set +a && npm run api:stagepilot"
else
  API_START_CMD="cd \"${ROOT_DIR}\" && npm run api:stagepilot"
fi
API_LOG_FILE="${STAGEPILOT_SMOKE_API_LOG:-/tmp/stagepilot-api-smoke.log}"
API_PID=""

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd jq
need_cmd rg

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
}

wait_for_health() {
  local attempts="${1:-40}"
  local delay="${2:-0.5}"
  for _ in $(seq 1 "${attempts}"); do
    if curl -fsS --max-time 2 "${BASE_URL}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${delay}"
  done
  return 1
}

curl_json() {
  curl -fsS --max-time "${CURL_MAX_TIME}" "$@"
}

trap cleanup EXIT

echo "[smoke-stagepilot] base_url=${BASE_URL} curl_max_time=${CURL_MAX_TIME}s"

if ! health_json="$(curl_json "${BASE_URL}/health" 2>/dev/null)"; then
  if [[ "${AUTO_START}" == "1" ]]; then
    echo "[smoke-stagepilot] health unavailable; starting API: ${API_START_CMD}"
    bash -lc "${API_START_CMD}" >"${API_LOG_FILE}" 2>&1 &
    API_PID="$!"
    if ! wait_for_health 40 0.5; then
      echo "[smoke-stagepilot] failed to start API. Recent log:" >&2
      tail -n 80 "${API_LOG_FILE}" >&2 || true
      exit 1
    fi
    health_json="$(curl_json "${BASE_URL}/health")"
  else
    echo "[smoke-stagepilot] health check failed and auto-start disabled" >&2
    exit 1
  fi
fi

health_ok="$(echo "${health_json}" | jq -r '.ok')"
if [[ "${health_ok}" != "true" ]]; then
  echo "[smoke-stagepilot] health check failed: ${health_json}" >&2
  exit 1
fi
echo "[smoke-stagepilot] health ok"

demo_html="$(curl_json "${BASE_URL}/demo")"
if ! echo "${demo_html}" | rg -q "StagePilot Judge Console"; then
  echo "[smoke-stagepilot] demo page check failed" >&2
  exit 1
fi
echo "[smoke-stagepilot] demo page ok"

plan_json="$(curl_json "${BASE_URL}/v1/plan" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"caseId":"smoke-001","district":"Gangbuk-gu","notes":"Food and housing instability","risks":["food","housing"],"urgencyHint":"high"}')"

plan_ok="$(echo "${plan_json}" | jq -r '.ok')"
plan_actions="$(echo "${plan_json}" | jq -r '.result.plan.actions | length')"
if [[ "${plan_ok}" != "true" ]] || [[ "${plan_actions}" -lt 1 ]]; then
  echo "[smoke-stagepilot] plan check failed: ${plan_json}" >&2
  exit 1
fi
echo "[smoke-stagepilot] plan ok (actions=${plan_actions})"

invalid_status="$(curl -s --max-time "${CURL_MAX_TIME}" -o /tmp/stagepilot-invalid.json -w "%{http_code}" \
  "${BASE_URL}/v1/plan" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"caseId":')"
if [[ "${invalid_status}" != "400" ]]; then
  echo "[smoke-stagepilot] invalid-json status mismatch: ${invalid_status}" >&2
  cat /tmp/stagepilot-invalid.json >&2
  exit 1
fi
echo "[smoke-stagepilot] invalid-json status ok (400)"

benchmark_json="$(curl_json "${BASE_URL}/v1/benchmark" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"caseCount":8,"maxLoopAttempts":2,"seed":20260228}')"
benchmark_ok="$(echo "${benchmark_json}" | jq -r '.ok')"
if [[ "${benchmark_ok}" != "true" ]]; then
  echo "[smoke-stagepilot] benchmark check failed: ${benchmark_json}" >&2
  exit 1
fi
echo "[smoke-stagepilot] benchmark ok"

whatif_json="$(curl_json "${BASE_URL}/v1/whatif" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"caseId":"smoke-whatif-001","district":"Jungnang-gu","notes":"Food isolation pressure","risks":["food","isolation"],"urgencyHint":"high","scenario":{"staffingDeltaPct":-10,"demandDeltaPct":15}}')"
whatif_ok="$(echo "${whatif_json}" | jq -r '.ok')"
whatif_recommendation="$(echo "${whatif_json}" | jq -r '.twin.recommendation.agencyName // empty')"
if [[ "${whatif_ok}" != "true" ]] || [[ -z "${whatif_recommendation}" ]]; then
  echo "[smoke-stagepilot] what-if check failed: ${whatif_json}" >&2
  exit 1
fi
echo "[smoke-stagepilot] what-if ok (recommended=${whatif_recommendation})"

notify_json="$(curl_json "${BASE_URL}/v1/notify" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"caseId":"smoke-notify-001","district":"Gangbuk-gu","notes":"Need route + dispatch","risks":["food","housing"],"urgencyHint":"high","delivery":{"channel":"telegram","target":"@welfare-ops","dryRun":true}}')"
notify_ok="$(echo "${notify_json}" | jq -r '.ok')"
notify_mode="$(echo "${notify_json}" | jq -r '.delivery.mode // empty')"
if [[ "${notify_ok}" != "true" ]] || [[ "${notify_mode}" != "dry-run" ]]; then
  echo "[smoke-stagepilot] notify check failed: ${notify_json}" >&2
  exit 1
fi
echo "[smoke-stagepilot] notify ok (mode=${notify_mode})"

inbox_json="$(curl_json "${BASE_URL}/v1/openclaw/inbox" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"message":"/whatif urgent food + housing support","district":"Gangbuk-gu","delivery":{"channel":"telegram","target":"@welfare-ops","dryRun":true},"scenario":{"staffingDeltaPct":-5,"demandDeltaPct":10}}')"
inbox_ok="$(echo "${inbox_json}" | jq -r '.ok')"
inbox_action="$(echo "${inbox_json}" | jq -r '.action // empty')"
inbox_mode="$(echo "${inbox_json}" | jq -r '.delivery.mode // empty')"
if [[ "${inbox_ok}" != "true" ]] || [[ "${inbox_action}" != "whatif" ]] || [[ "${inbox_mode}" != "dry-run" ]]; then
  echo "[smoke-stagepilot] inbox check failed: ${inbox_json}" >&2
  exit 1
fi
echo "[smoke-stagepilot] inbox ok (action=${inbox_action}, mode=${inbox_mode})"

echo "[smoke-stagepilot] PASS"
