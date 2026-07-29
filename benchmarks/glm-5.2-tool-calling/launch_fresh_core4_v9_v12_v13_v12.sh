#!/usr/bin/env bash
set -uo pipefail

REPO=/home/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
BENCH="$REPO/benchmarks/glm-5.2-tool-calling"
RESULTS="$BENCH/results"
WRAPPER="$BENCH/with_secure_key_source.py"
BRIDGE="$BENCH/src/openai-compat-bridge.ts"
HAMMER="$RESULTS/2026-07-18-hammerbench-full-61075-fresh-v9"
BFCL="$RESULTS/2026-07-18-bfcl-v4-full-fresh-v12"
STABLE="$RESULTS/2026-07-18-stabletoolbench-full-765-fresh-v13"
TAU="$RESULTS/2026-07-18-tau3-base-375-fresh-v12"
EXPECTED_PARSER_SHA=5c938f29a08fa16c4558be257b071023a0c8802d4afbb788d2b7f9a295069256

bridge_pids=()
runner_pids=()
runner_names=()

cleanup() {
  for pid in "${runner_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${bridge_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
}
trap cleanup INT TERM

start_bridge() {
  local name=$1 port=$2 output=$3 suite=$4 log=$5
  python3 "$WRAPPER" -- env \
    OPENAI_BRIDGE_OUTPUT="$output" \
    OPENAI_BRIDGE_PORT="$port" \
    OPENAI_BRIDGE_SUITE="$suite" \
    OPENAI_BRIDGE_MAX_OUTPUT_TOKENS=16384 \
    OPENAI_BRIDGE_TIMEOUT_MS=180000 \
    OPENAI_BRIDGE_TRANSIENT_RETRIES=4 \
    OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS=5000 \
    OPENAI_BRIDGE_TRANSPORT=generate \
    node --import "$REPO/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs" \
    "$BRIDGE" >"$log" 2>&1 &
  local pid=$!
  bridge_pids+=("$pid")
  echo "BRIDGE_FORK name=$name pid=$pid port=$port"
}

wait_health() {
  local name=$1 port=$2
  for _ in $(seq 1 120); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" >"/tmp/${name}-health.json"; then
      echo "HEALTH_OK name=$name port=$port payload=$(tr -d '\n' <"/tmp/${name}-health.json")"
      return 0
    fi
    sleep 0.25
  done
  echo "HEALTH_FAIL name=$name port=$port" >&2
  return 1
}

start_runner() {
  local name=$1 log=$2
  shift 2
  python3 "$WRAPPER" -- env PYTHONUNBUFFERED=1 "$@" >"$log" 2>&1 &
  local pid=$!
  runner_names+=("$name")
  runner_pids+=("$pid")
  echo "RUNNER_FORK name=$name pid=$pid"
}

cd "$REPO"
actual_parser_sha=$(sha256sum src/core/protocols/glm5-call-parsing.ts | cut -d' ' -f1)
if [[ "$actual_parser_sha" != "$EXPECTED_PARSER_SHA" ]]; then
  echo "PARSER_SHA_GATE_FAIL expected=$EXPECTED_PARSER_SHA actual=$actual_parser_sha" >&2
  exit 1
fi
python3 - "$REPO" "$HAMMER" "$BFCL" "$STABLE" "$TAU" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

expected_admissions = (64, 24, 4, 8)
root = Path(sys.argv[1])
for run_root, admission in zip(map(Path, sys.argv[2:]), expected_admissions, strict=True):
    path = run_root / "run-meta.json"
    metadata = json.load(open(path, encoding="utf-8"))
    if metadata.get("launchAuthorized") is not True:
        raise SystemExit(f"LAUNCH_AUTH_GATE_FAIL path={path}")
    if metadata.get("bridgeMaxOutputTokens") != 16384:
        raise SystemExit(f"CAP_GATE_FAIL path={path}")
    if metadata.get("totalAdmission") != admission:
        raise SystemExit(f"ADMISSION_GATE_FAIL path={path}")
    attestation = metadata.get("runtimeStartAttestation", {})
    if attestation.get("parserSha256") != "5c938f29a08fa16c4558be257b071023a0c8802d4afbb788d2b7f9a295069256":
        raise SystemExit(f"FINGERPRINT_SHA_GATE_FAIL path={path}")
    fingerprint = json.load(open(run_root / "runtime-fingerprint.json", encoding="utf-8"))["runtimeFingerprint"]
    if len(fingerprint["files"]["parser"]) != 122:
        raise SystemExit(f"FULL_SRC_COUNT_GATE_FAIL path={path}")
    for records in fingerprint["files"].values():
        for record in records:
            current = hashlib.sha256((root / record["path"]).read_bytes()).hexdigest()
            if current != record["sha256"]:
                raise SystemExit(f"RUNTIME_DRIFT_GATE_FAIL path={record['path']}")
print("PRELAUNCH_METADATA_GATE_OK cap=16384 admission=100")
PY
start_bridge hammer 8864 "$HAMMER" hammerbench-full-61075-fresh-v9 "$HAMMER/bridge.log"
start_bridge bfcl 8865 "$BFCL" bfcl-v4-full-fresh-v12 "$BFCL/bridge.log"
start_bridge stable 8866 "$STABLE/bridge" 2026-07-18-stabletoolbench-full-765-fresh-v13 "$STABLE/bridge.log"
start_bridge tau3 8867 "$TAU/bridge" 2026-07-18-tau3-base-375-fresh-v12 "$TAU/bridge.log"

wait_health hammer 8864 || exit 1
wait_health bfcl 8865 || exit 1
wait_health stable 8866 || exit 1
wait_health tau3 8867 || exit 1

for file in \
  "$HAMMER/requests.jsonl" "$HAMMER/provider-raw.jsonl" \
  "$BFCL/requests.jsonl" "$BFCL/provider-raw.jsonl" \
  "$STABLE/bridge/requests.jsonl" "$STABLE/bridge/provider-raw.jsonl" \
  "$TAU/bridge/requests.jsonl" "$TAU/bridge/provider-raw.jsonl"; do
  if [[ ! -f "$file" || -s "$file" ]]; then
    echo "ZERO_GATE_FAIL file=$file" >&2
    exit 1
  fi
done
for path in \
  "$HAMMER/glm52-native.jsonl" "$HAMMER/glm52-native-plus.jsonl" \
  "$BFCL/official" "$STABLE/official" "$TAU/data" "$TAU/logs"; do
  if [[ -e "$path" || -L "$path" ]]; then
    echo "FRESH_OUTPUT_FAIL path=$path" >&2
    exit 1
  fi
done
echo "ZERO_GATE_OK bridgeRequestRows=0 bridgeProviderRows=0 historicalRowsReused=0"

mkdir "$BFCL/official"
start_runner hammer-native "$HAMMER/hammer-native.log" \
  /home/minpeter/.cache/glm52-benchmarks/hammerbench/.venv/bin/python \
  "$BENCH/hammerbench_official_native.py" \
  --data-root /home/minpeter/.cache/glm52-benchmarks/hammerbench-data \
  --base-url http://127.0.0.1:8864/v1 --model glm52-native \
  --out "$HAMMER/glm52-native.jsonl" --threads 32 --timeout 960
start_runner hammer-native-plus "$HAMMER/hammer-native-plus.log" \
  /home/minpeter/.cache/glm52-benchmarks/hammerbench/.venv/bin/python \
  "$BENCH/hammerbench_official_native.py" \
  --data-root /home/minpeter/.cache/glm52-benchmarks/hammerbench-data \
  --base-url http://127.0.0.1:8864/v1 --model glm52-native-plus \
  --out "$HAMMER/glm52-native-plus.jsonl" --threads 32 --timeout 960

start_runner bfcl-native "$BFCL/bfcl-native.log" \
  env OPENAI_BASE_URL=http://127.0.0.1:8865/v1 OPENAI_API_KEY=bridge-local \
  BFCL_WEB_SEARCH_BACKEND=duckduckgo-html BFCL_REQUEST_TIMEOUT_SECONDS=960 \
  BFCL_CLIENT_MAX_RETRIES=6 \
  /home/minpeter/.cache/glm52-benchmarks/bfcl/berkeley-function-call-leaderboard/.venv/bin/python \
  "$BENCH/bfcl_official.py" generate --model glm52-native \
  --test-category all_scoring --temperature 0.001 --num-threads 12 \
  --result-dir "$BFCL/official"
start_runner bfcl-native-plus "$BFCL/bfcl-native-plus.log" \
  env OPENAI_BASE_URL=http://127.0.0.1:8865/v1 OPENAI_API_KEY=bridge-local \
  BFCL_WEB_SEARCH_BACKEND=duckduckgo-html BFCL_REQUEST_TIMEOUT_SECONDS=960 \
  BFCL_CLIENT_MAX_RETRIES=6 \
  /home/minpeter/.cache/glm52-benchmarks/bfcl/berkeley-function-call-leaderboard/.venv/bin/python \
  "$BENCH/bfcl_official.py" generate --model glm52-native-plus \
  --test-category all_scoring --temperature 0.001 --num-threads 12 \
  --result-dir "$BFCL/official"

start_runner stable "$STABLE/stable-runner.log" \
  /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/.venv/bin/python \
  "$BENCH/stabletoolbench_full_native.py" --repo-root "$REPO" \
  --code-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench \
  --tool-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/server/tools \
  --output-root "$STABLE" \
  --python /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/.venv/bin/python \
  --base-url http://127.0.0.1:8866/v1 --threads 1 \
  --request-timeout-seconds 960 --group-concurrency 2 \
  --service-mode managed-per-lane-readonly-snapshot \
  --service-server-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/server \
  --service-cache-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/server/tool_response_cache \
  --service-start-port 32500 --service-ready-timeout 120 \
  --simulator-model glm52-simulator

start_runner tau3 "$TAU/tau3-runner.log" \
  /home/minpeter/.cache/glm52-benchmarks/tau3/.venv/bin/python \
  "$BENCH/tau3_full_native.py" --repo-root "$REPO" \
  --tau-root /home/minpeter/.cache/glm52-benchmarks/tau3 \
  --output-root "$TAU" \
  --python /home/minpeter/.cache/glm52-benchmarks/tau3/.venv/bin/python \
  --base-url http://127.0.0.1:8867/v1 --save-prefix fresh-v12 \
  --request-timeout-seconds 960 --domain-workers 4 \
  --task-concurrency-per-run 1

echo "ADMISSION_CONFIG_OK hammer=64 bfcl=24 stable=4 tau3=8 total=100"

while true; do
  alive=0
  snapshot=()
  for index in "${!runner_pids[@]}"; do
    pid=${runner_pids[$index]}
    name=${runner_names[$index]}
    if kill -0 "$pid" 2>/dev/null; then
      alive=$((alive + 1))
      snapshot+=("$name:$pid:running")
    else
      snapshot+=("$name:$pid:exited")
    fi
  done
  echo "RUNNER_STATUS alive=$alive ${snapshot[*]}"
  [[ $alive -eq 0 ]] && break
  sleep 30
done

exit_code=0
for index in "${!runner_pids[@]}"; do
  pid=${runner_pids[$index]}
  name=${runner_names[$index]}
  if wait "$pid"; then
    echo "RUNNER_COMPLETE name=$name exit=0"
  else
    code=$?
    echo "RUNNER_COMPLETE name=$name exit=$code" >&2
    exit_code=1
  fi
done
for pid in "${bridge_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
wait "${bridge_pids[@]}" 2>/dev/null || true
exit "$exit_code"
