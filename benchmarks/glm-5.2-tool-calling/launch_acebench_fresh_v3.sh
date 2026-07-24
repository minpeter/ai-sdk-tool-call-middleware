#!/usr/bin/env bash
set -euo pipefail

MODE=${1:-}
if [[ "$MODE" != preflight && "$MODE" != full ]]; then
  echo "usage: $0 preflight|full" >&2
  exit 2
fi

REPO=${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
BENCH="$REPO/benchmarks/glm-5.2-tool-calling"
BASE="$BENCH/results/2026-07-18-acebench-full-2040-fresh-v3"
ACE_ROOT=${ACE_ROOT:-/tmp/acebench-function-calling}
ACE_PYTHON="$ACE_ROOT/.venv/bin/python"
ADAPTER="$BENCH/acebench_official_native.py"
PREFLIGHT="$BENCH/acebench_one_row_preflight.py"
WRAPPER="$BENCH/with_secure_key_source.py"
BRIDGE="$BENCH/src/openai-compat-bridge.ts"
LOADER="$REPO/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs"
EXPECTED_PARSER_SHA=5c938f29a08fa16c4558be257b071023a0c8802d4afbb788d2b7f9a295069256
EXPECTED_TASK_SET_SHA=3967082cc1ed8e4a532ae290f099947241d6fe12e23e08f10c7109f5d7f01b74
CAP=16384
THREADS=2

runner_pids=()
bridge_pid=
cleanup() {
  for pid in "${runner_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  [[ -n "$bridge_pid" ]] && kill -TERM "$bridge_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

cd "$REPO"
actual_parser_sha=$(sha256sum src/core/protocols/glm5-call-parsing.ts | cut -d' ' -f1)
if [[ "$actual_parser_sha" != "$EXPECTED_PARSER_SHA" ]]; then
  echo "PARSER_SHA_GATE_FAIL expected=$EXPECTED_PARSER_SHA actual=$actual_parser_sha" >&2
  exit 1
fi

python3 "$BENCH/build_acebench_full_manifest.py" \
  --root "$ACE_ROOT" --out "$BASE/task-manifest.json" --validate >/dev/null

python3 - "$REPO" "$BASE" "$EXPECTED_PARSER_SHA" "$EXPECTED_TASK_SET_SHA" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

repo = Path(sys.argv[1])
base = Path(sys.argv[2])
expected_parser = sys.argv[3]
expected_tasks = sys.argv[4]
manifest = json.loads((base / "task-manifest.json").read_text(encoding="utf-8"))
metadata = json.loads((base / "run-meta.json").read_text(encoding="utf-8"))
fingerprint = json.loads(
    (base / "runtime-fingerprint.json").read_text(encoding="utf-8")
)["runtimeFingerprint"]
if manifest.get("rowCount") != 2040 or manifest.get("taskSetSha256") != expected_tasks:
    raise SystemExit("MANIFEST_GATE_FAIL")
if metadata.get("taskSetSha256") != expected_tasks:
    raise SystemExit("METADATA_TASK_GATE_FAIL")
if metadata.get("providerMaxTokens") != {"assistant": 16384, "userSimulator": 16384}:
    raise SystemExit("CAP_METADATA_GATE_FAIL")
if metadata.get("stableAdmission") != {
    "arms": 2,
    "languages": 2,
    "threadsPerArmLanguage": 2,
    "total": 8,
}:
    raise SystemExit("ADMISSION_METADATA_GATE_FAIL")
if metadata.get("runtimeStartAttestation", {}).get("parserSha256") != expected_parser:
    raise SystemExit("PARSER_ATTESTATION_GATE_FAIL")
if metadata.get("runtimeFingerprintAggregateSha256") != fingerprint.get("aggregateSha256"):
    raise SystemExit("FINGERPRINT_METADATA_GATE_FAIL")
for records in fingerprint.get("files", {}).values():
    for record in records:
        source = repo / record["path"]
        if hashlib.sha256(source.read_bytes()).hexdigest() != record["sha256"]:
            raise SystemExit(f"RUNTIME_DRIFT_GATE_FAIL path={record['path']}")
print("ACEBENCH_METADATA_GATE_OK rows=2040 cap=16384 admission=8")
PY

start_bridge() {
  local bridge_root=$1
  local port=$2
  local suite=$3
  mkdir "$bridge_root"
  python3 "$WRAPPER" -- env \
    OPENAI_BRIDGE_OUTPUT="$bridge_root" \
    OPENAI_BRIDGE_PORT="$port" \
    OPENAI_BRIDGE_SUITE="$suite" \
    OPENAI_BRIDGE_MAX_OUTPUT_TOKENS="$CAP" \
    OPENAI_BRIDGE_TIMEOUT_MS=180000 \
    OPENAI_BRIDGE_TRANSIENT_RETRIES=4 \
    OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS=5000 \
    OPENAI_BRIDGE_TRANSPORT=generate \
    node --import "$LOADER" "$BRIDGE" >"$bridge_root/bridge.log" 2>&1 &
  bridge_pid=$!
  for _ in $(seq 1 120); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then
      break
    fi
    sleep 0.25
  done
  if ! curl --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then
    echo "ACEBENCH_BRIDGE_HEALTH_FAIL port=$port" >&2
    exit 1
  fi
  for file in "$bridge_root/requests.jsonl" "$bridge_root/provider-raw.jsonl"; do
    if [[ ! -f "$file" || -s "$file" ]]; then
      echo "ACEBENCH_ZERO_GATE_FAIL file=$file" >&2
      exit 1
    fi
  done
  echo "ACEBENCH_BRIDGE_READY port=$port zeroRows=1"
}

if [[ "$MODE" == preflight ]]; then
  BRIDGE_ROOT="$BASE/bridge-preflight"
  EVIDENCE="$BASE/one-row-cap-linkage-preflight.json"
  if [[ -e "$BRIDGE_ROOT" || -L "$BRIDGE_ROOT" || -e "$EVIDENCE" || -L "$EVIDENCE" ]]; then
    echo "ACEBENCH_PREFLIGHT_FRESHNESS_FAIL" >&2
    exit 1
  fi
  start_bridge "$BRIDGE_ROOT" 18860 acebench-full-2040-fresh-v3-preflight
  python3 "$WRAPPER" -- env \
    ACEBENCH_ROOT="$ACE_ROOT" \
    "$ACE_PYTHON" "$PREFLIGHT" \
    --manifest "$BASE/task-manifest.json" \
    --bridge-root "$BRIDGE_ROOT" \
    --output "$EVIDENCE" \
    --base-url http://127.0.0.1:18860/v1 \
    --arm glm52-native-plus-FC \
    --language en \
    --category agent_multi_turn \
    --task-id agent_multi_turn_0
  python3 "$WRAPPER" -- python3 "$BENCH/validate_provider_capture.py" \
    --capture "$BRIDGE_ROOT/provider-raw.jsonl" >/dev/null
  echo "ACEBENCH_PREFLIGHT_COMPLETE evidence=$EVIDENCE"
  exit 0
fi

if [[ ${ACEBENCH_FULL_LAUNCH:-} != YES ]]; then
  echo "ACEBENCH_FULL_LAUNCH_BLOCKED set ACEBENCH_FULL_LAUNCH=YES only after admission is available" >&2
  exit 1
fi
python3 - "$BASE/one-row-cap-linkage-preflight.json" <<'PY'
import json
from pathlib import Path
import sys

value = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if value.get("status") != "valid-one-row-cap-linkage-preflight":
    raise SystemExit("PREFLIGHT_STATUS_GATE_FAIL")
if value.get("capVerified") != 16384 or value.get("zeroReuseVerified") is not True:
    raise SystemExit("PREFLIGHT_CAP_GATE_FAIL")
if value.get("modelsObserved") != ["glm52-native-plus-FC", "glm52-simulator"]:
    raise SystemExit("PREFLIGHT_MODEL_GATE_FAIL")
PY

BRIDGE_ROOT="$BASE/bridge-full"
WORK_ROOT="$BASE/workdir-full"
if [[ -e "$BRIDGE_ROOT" || -L "$BRIDGE_ROOT" || -e "$WORK_ROOT" || -L "$WORK_ROOT" ]]; then
  echo "ACEBENCH_FULL_FRESHNESS_FAIL" >&2
  exit 1
fi
start_bridge "$BRIDGE_ROOT" 18861 acebench-full-2040-fresh-v3
mkdir "$WORK_ROOT"
ln -s "$ACE_ROOT/data_all" "$WORK_ROOT/data_all"

launch_lane() {
  local arm=$1
  local language=$2
  (
    cd "$WORK_ROOT"
    python3 "$WRAPPER" -- env \
      ACEBENCH_ROOT="$ACE_ROOT" \
      OPENAI_API_KEY=acebench-loopback-only \
      OPENAI_BASE_URL=http://127.0.0.1:18861/v1 \
      PYTHONUNBUFFERED=1 \
      "$ACE_PYTHON" "$ADAPTER" \
      --model "$arm" \
      --category test_all \
      --temperature 0.001 \
      --top-p 1 \
      --max-tokens "$CAP" \
      --max-dialog-turns 40 \
      --user-model glm52-simulator \
      --language "$language" \
      --num-threads "$THREADS"
  ) >"$BASE/${arm}-${language}.log" 2>&1 &
  runner_pids+=("$!")
  echo "ACEBENCH_LANE_FORK arm=$arm language=$language threads=$THREADS pid=$!"
}

for arm in glm52-native-FC glm52-native-plus-FC; do
  for language in en zh; do
    launch_lane "$arm" "$language"
  done
done
echo "ACEBENCH_ADMISSION_OK arms=2 languages=2 threads=2 total=8 globalCeiling=128"

exit_code=0
for pid in "${runner_pids[@]}"; do
  if ! wait "$pid"; then
    exit_code=1
  fi
done
runner_pids=()
if [[ $exit_code -ne 0 ]]; then
  echo "ACEBENCH_RUNNER_FAILURE" >&2
  exit "$exit_code"
fi

python3 "$BENCH/validate_acebench_official.py" \
  --manifest "$BASE/task-manifest.json" \
  --result-root "$WORK_ROOT/result_all" >/dev/null
python3 "$WRAPPER" -- python3 "$BENCH/validate_provider_capture.py" \
  --capture "$BRIDGE_ROOT/provider-raw.jsonl" >/dev/null
echo "ACEBENCH_FULL_COMPLETE freshRows=4080 scoreDisclosure=locked"
