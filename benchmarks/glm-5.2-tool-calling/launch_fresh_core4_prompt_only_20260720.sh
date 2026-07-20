#!/usr/bin/env bash
set -euo pipefail

REPO=/home/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
BENCH="$REPO/benchmarks/glm-5.2-tool-calling"
RESULTS="$BENCH/results"
WRAPPER="$BENCH/with_secure_key_source.py"
BRIDGE="$BENCH/src/openai-compat-bridge.ts"
EXPECTED_PARSER_SHA=f8628c470666ad1641e8af813772f972e13285e9e622d5f744ce69daf384a214
PRELAUNCH_FREE_BYTES=79100000000
STOP_FLOOR_BYTES=59100000000
TMP_MIN_FREE_BYTES=20000000000
MIN_NOFILE=65536
ACTIVE_SUITE=${ACTIVE_SUITE:?set ACTIVE_SUITE to hammer, bfcl, stable, or tau3}
LAUNCH_MODE=${LAUNCH_MODE:-plan}

case "$ACTIVE_SUITE" in
  hammer)
    RUN_ROOT="$RESULTS/2026-07-20-glm52-native-vs-prompt-only-hammerbench-61075-fresh-v1"
    PORT=18864
    CASES_PER_ARM=61075
    FRESH_TRAJECTORIES=122150
    ADMISSION_CAP=8
    ;;
  bfcl)
    RUN_ROOT="$RESULTS/2026-07-20-glm52-native-vs-prompt-only-bfcl-5217-fresh-v1"
    PORT=18865
    CASES_PER_ARM=5217
    FRESH_TRAJECTORIES=10434
    ADMISSION_CAP=8
    ;;
  stable)
    RUN_ROOT="$RESULTS/2026-07-20-glm52-native-vs-prompt-only-stabletoolbench-765-fresh-v1"
    PORT=18866
    CASES_PER_ARM=765
    FRESH_TRAJECTORIES=1530
    ADMISSION_CAP=4
    ;;
  tau3)
    RUN_ROOT="$RESULTS/2026-07-20-glm52-native-vs-prompt-only-tau3-375-fresh-v1"
    PORT=18867
    CASES_PER_ARM=375
    FRESH_TRAJECTORIES=750
    ADMISSION_CAP=4
    ;;
  *)
    echo "unsupported ACTIVE_SUITE=$ACTIVE_SUITE" >&2
    exit 2
    ;;
esac

if [[ "$LAUNCH_MODE" == plan ]]; then
  if [[ -e "$RUN_ROOT" || -L "$RUN_ROOT" ]]; then
    echo "FRESH_ROOT_COLLISION suite=$ACTIVE_SUITE root=$RUN_ROOT" >&2
    exit 1
  fi
  echo "PLAN suite=$ACTIVE_SUITE root=$RUN_ROOT cap=$ADMISSION_CAP coLaunch=false retryOwner=bridge providerCalls=0"
  exit 0
fi
if [[ "$LAUNCH_MODE" != run ]]; then
  echo "unsupported LAUNCH_MODE=$LAUNCH_MODE" >&2
  exit 2
fi

free_bytes=$(($(stat -f -c %a "$RESULTS") * $(stat -f -c %S "$RESULTS")))
tmp_free_bytes=$(($(stat -f -c %a /tmp) * $(stat -f -c %S /tmp)))
if ((free_bytes < PRELAUNCH_FREE_BYTES)); then
  echo "HOST_FREE_SPACE_GATE_FAIL free=$free_bytes required=$PRELAUNCH_FREE_BYTES stopFloor=$STOP_FLOOR_BYTES" >&2
  exit 1
fi
if ((tmp_free_bytes < TMP_MIN_FREE_BYTES)); then
  echo "HOST_TMP_SPACE_GATE_FAIL free=$tmp_free_bytes required=$TMP_MIN_FREE_BYTES" >&2
  exit 1
fi
if (( $(ulimit -n) < MIN_NOFILE )); then
  echo "HOST_NOFILE_GATE_FAIL current=$(ulimit -n) required=$MIN_NOFILE" >&2
  exit 1
fi
swap_total=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
swap_free=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
if [[ "$swap_total" != "$swap_free" ]]; then
  echo "HOST_SWAP_GATE_FAIL usedKiB=$((swap_total - swap_free))" >&2
  exit 1
fi
if ! awk '$1 == "full" {split($2, value, "="); exit !(value[2] == 0)}' /proc/pressure/io; then
  echo "HOST_IO_PRESSURE_GATE_FAIL" >&2
  exit 1
fi
if pgrep -f "$RESULTS/2026-07-20-glm52-native-vs-prompt-only-" >/dev/null; then
  echo "ONE_SUITE_GATE_FAIL another 2026-07-20 campaign process is active" >&2
  exit 1
fi
if [[ ! -d "$RUN_ROOT" || -L "$RUN_ROOT" ]]; then
  echo "PREPARED_ROOT_GATE_FAIL root=$RUN_ROOT" >&2
  exit 1
fi

actual_parser_sha=$(sha256sum "$REPO/src/core/protocols/glm5-call-parsing.ts" | cut -d' ' -f1)
if [[ "$actual_parser_sha" != "$EXPECTED_PARSER_SHA" ]]; then
  echo "PARSER_SHA_GATE_FAIL expected=$EXPECTED_PARSER_SHA actual=$actual_parser_sha" >&2
  exit 1
fi

python3 - "$REPO" "$RUN_ROOT" "$CASES_PER_ARM" "$FRESH_TRAJECTORIES" "$EXPECTED_PARSER_SHA" "$ADMISSION_CAP" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

repo = Path(sys.argv[1])
run_root = Path(sys.argv[2])
cases_per_arm = int(sys.argv[3])
fresh_trajectories = int(sys.argv[4])
parser_sha = sys.argv[5]
admission_cap = int(sys.argv[6])
with (run_root / "run-meta.json").open(encoding="utf-8") as handle:
    metadata = json.load(handle)
with (run_root / "campaign-binding.json").open(encoding="utf-8") as handle:
    binding = json.load(handle)
with (run_root / "runtime-fingerprint.json").open(encoding="utf-8") as handle:
    fingerprint = json.load(handle)["runtimeFingerprint"]
if metadata.get("arms") != ["glm52-native", "glm52-prompt-only"]:
    raise SystemExit("ARM_GATE_FAIL")
if metadata.get("populationPerArm") != cases_per_arm:
    raise SystemExit("DENOMINATOR_GATE_FAIL")
if metadata.get("expectedFreshTrajectories") != fresh_trajectories:
    raise SystemExit("TRAJECTORY_GATE_FAIL")
if metadata.get("totalAdmission") != admission_cap:
    raise SystemExit("ADMISSION_GATE_FAIL")
if metadata.get("runtimeStartAttestation", {}).get("parserSha256") != parser_sha:
    raise SystemExit("PARSER_ATTESTATION_GATE_FAIL")
aggregate = fingerprint.get("aggregateSha256")
if metadata.get("runtimeFingerprintAggregateSha256") != aggregate:
    raise SystemExit("FINGERPRINT_BINDING_GATE_FAIL")
if binding.get("runtimeFingerprintAggregateSha256") != aggregate:
    raise SystemExit("CAMPAIGN_BINDING_GATE_FAIL")
if binding.get("arms") != ["glm52-native", "glm52-prompt-only"]:
    raise SystemExit("CAMPAIGN_ARM_GATE_FAIL")
if binding.get("runId") != metadata.get("runId"):
    raise SystemExit("CAMPAIGN_RUN_ID_GATE_FAIL")
if binding.get("suiteId") != metadata.get("benchmarkId"):
    raise SystemExit("CAMPAIGN_SUITE_ID_GATE_FAIL")
if binding.get("taskSetSha256") != metadata.get("taskSetSha256"):
    raise SystemExit("CAMPAIGN_TASK_SET_GATE_FAIL")
if binding.get("expectedCasesPerArm") != cases_per_arm:
    raise SystemExit("CAMPAIGN_DENOMINATOR_GATE_FAIL")
if binding.get("expectedFreshTrajectories") != fresh_trajectories:
    raise SystemExit("CAMPAIGN_TRAJECTORY_GATE_FAIL")
if binding.get("resume") is not False or binding.get("preseed") is not False:
    raise SystemExit("ZERO_REUSE_GATE_FAIL")
if any(binding.get(key) != [] for key in (
    "historicalCaptureInputs", "historicalResultInputs", "sourceRunRoots"
)) or binding.get("reusedCases") != 0:
    raise SystemExit("HISTORICAL_INPUT_GATE_FAIL")
for records in fingerprint["files"].values():
    for record in records:
        current = hashlib.sha256((repo / record["path"]).read_bytes()).hexdigest()
        if current != record["sha256"]:
            raise SystemExit(f"RUNTIME_DRIFT_GATE_FAIL path={record['path']}")
PY

bridge_pid=
runner_pids=()
cleanup() {
  for pid in "${runner_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  if [[ -n "$bridge_pid" ]]; then kill -TERM "$bridge_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

BRIDGE_SUITE=$(jq -er .bridgeSuite "$RUN_ROOT/run-meta.json")
BRIDGE_OUT="$RUN_ROOT/bridge"
if [[ -e "$BRIDGE_OUT" || -L "$BRIDGE_OUT" ]]; then
  echo "BRIDGE_ROOT_COLLISION root=$BRIDGE_OUT" >&2
  exit 1
fi
mkdir -m 700 -- "$BRIDGE_OUT"
python3 "$WRAPPER" -- env \
  OPENAI_BRIDGE_OUTPUT="$BRIDGE_OUT" \
  OPENAI_BRIDGE_PORT="$PORT" \
  OPENAI_BRIDGE_SUITE="$BRIDGE_SUITE" \
  OPENAI_BRIDGE_MAX_OUTPUT_TOKENS=16384 \
  OPENAI_BRIDGE_TIMEOUT_MS=180000 \
  OPENAI_BRIDGE_TRANSIENT_RETRIES=2 \
  OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS=5000 \
  OPENAI_BRIDGE_TRANSPORT=generate \
  OPENAI_BRIDGE_RESUME=0 \
  node --import "$REPO/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs" \
  "$BRIDGE" >"$RUN_ROOT/bridge.log" 2>&1 &
bridge_pid=$!

for _ in $(seq 1 120); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null; then break; fi
  sleep 0.25
done
curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null
for file in "$BRIDGE_OUT/requests.jsonl" "$BRIDGE_OUT/provider-raw.jsonl"; do
  if [[ ! -f "$file" || -s "$file" ]]; then
    echo "ZERO_CAPTURE_GATE_FAIL file=$file" >&2
    exit 1
  fi
done

start_runner() {
  local log=$1
  shift
  python3 "$WRAPPER" -- env PYTHONUNBUFFERED=1 "$@" >"$log" 2>&1 &
  runner_pids+=("$!")
}

case "$ACTIVE_SUITE" in
  hammer)
    for arm in glm52-native glm52-prompt-only; do
      start_runner "$RUN_ROOT/$arm.log" \
        /home/minpeter/.cache/glm52-benchmarks/hammerbench/.venv/bin/python \
        "$BENCH/hammerbench_official_native.py" \
        --data-root /home/minpeter/.cache/glm52-benchmarks/hammerbench-data \
        --base-url "http://127.0.0.1:$PORT/v1" --model "$arm" \
        --out "$RUN_ROOT/$arm.jsonl" --threads 4 --timeout 960
    done
    ;;
  bfcl)
    mkdir "$RUN_ROOT/official"
    for arm in glm52-native glm52-prompt-only; do
      start_runner "$RUN_ROOT/$arm.log" env \
        OPENAI_BASE_URL="http://127.0.0.1:$PORT/v1" OPENAI_API_KEY=bridge-local \
        BFCL_WEB_SEARCH_BACKEND=duckduckgo-html BFCL_REQUEST_TIMEOUT_SECONDS=960 \
        BFCL_CLIENT_MAX_RETRIES=0 \
        /home/minpeter/.cache/glm52-benchmarks/bfcl/berkeley-function-call-leaderboard/.venv/bin/python \
        "$BENCH/bfcl_official.py" generate --model "$arm" \
        --test-category all_scoring --temperature 0.001 --num-threads 4 \
        --result-dir "$RUN_ROOT/official"
    done
    ;;
  stable)
    start_runner "$RUN_ROOT/stable-runner.log" \
      /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/.venv/bin/python \
      "$BENCH/stabletoolbench_full_native.py" --repo-root "$REPO" \
      --code-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench \
      --tool-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/server/tools \
      --output-root "$RUN_ROOT" \
      --python /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/.venv/bin/python \
      --base-url "http://127.0.0.1:$PORT/v1" --threads 2 \
      --request-timeout-seconds 960 --group-concurrency 1 \
      --service-mode managed-per-lane-readonly-snapshot \
      --service-server-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/server \
      --service-cache-root /home/minpeter/.cache/glm52-benchmarks/stabletoolbench/server/tool_response_cache \
      --service-start-port 32500 --service-ready-timeout 120 \
      --simulator-model glm52-simulator
    ;;
  tau3)
    start_runner "$RUN_ROOT/tau3-runner.log" \
      /home/minpeter/.cache/glm52-benchmarks/tau3/.venv/bin/python \
      "$BENCH/tau3_full_native.py" --repo-root "$REPO" \
      --tau-root /home/minpeter/.cache/glm52-benchmarks/tau3 \
      --output-root "$RUN_ROOT" \
      --python /home/minpeter/.cache/glm52-benchmarks/tau3/.venv/bin/python \
      --base-url "http://127.0.0.1:$PORT/v1" --save-prefix prompt-only-20260720 \
      --request-timeout-seconds 960 --domain-workers 2 \
      --task-concurrency-per-run 1
    ;;
esac

exit_code=0
for pid in "${runner_pids[@]}"; do
  if ! wait "$pid"; then exit_code=1; fi
done
exit "$exit_code"
