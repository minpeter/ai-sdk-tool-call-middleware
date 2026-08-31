#!/usr/bin/env bash
set -uo pipefail

REPO=/home/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
BENCH="$REPO/benchmarks/glm-5.2-tool-calling"
BASE="$BENCH/results/2026-07-18-vakra-test-5207-fresh-v2"
BRIDGE_ROOT="$BASE/bridge-full-fresh-v11"
OUTPUT_ROOT="$BASE/full-fresh-v11"
WRAPPER="$BENCH/with_secure_key_source.py"
BRIDGE="$BENCH/src/openai-compat-bridge.ts"
EXPECTED_PARSER_SHA=5c938f29a08fa16c4558be257b071023a0c8802d4afbb788d2b7f9a295069256

bridge_pid=
runner_pid=
cleanup() {
  [[ -n "$runner_pid" ]] && kill -TERM "$runner_pid" 2>/dev/null || true
  [[ -n "$bridge_pid" ]] && kill -TERM "$bridge_pid" 2>/dev/null || true
}
trap cleanup INT TERM

cd "$REPO"
actual_parser_sha=$(sha256sum src/core/protocols/glm5-call-parsing.ts | cut -d' ' -f1)
if [[ "$actual_parser_sha" != "$EXPECTED_PARSER_SHA" ]]; then
  echo "PARSER_SHA_GATE_FAIL expected=$EXPECTED_PARSER_SHA actual=$actual_parser_sha" >&2
  exit 1
fi
python3 - "$REPO" "$BRIDGE_ROOT" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
run_root = Path(sys.argv[2])
metadata = json.load(open(run_root / "run-meta.json", encoding="utf-8"))
if metadata.get("launchAuthorized") is not True:
    raise SystemExit("LAUNCH_AUTH_GATE_FAIL")
if metadata.get("bridgeMaxOutputTokens") != 16384:
    raise SystemExit("CAP_GATE_FAIL")
if metadata.get("totalAdmission") != 16:
    raise SystemExit("ADMISSION_GATE_FAIL")
if metadata.get("runtimeStartAttestation", {}).get("parserSha256") != "5c938f29a08fa16c4558be257b071023a0c8802d4afbb788d2b7f9a295069256":
    raise SystemExit("FINGERPRINT_SHA_GATE_FAIL")
dataset = json.load(open(run_root / "dataset-sync.json", encoding="utf-8"))
dry_run = json.load(open(run_root / "dry-run.json", encoding="utf-8"))
if dataset.get("status") != "valid" or dataset.get("testRowsVerified") != 5207:
    raise SystemExit("VAKRA_DATASET_GATE_FAIL")
if dry_run.get("status") != "valid-dry-run" or dry_run.get("domainPairCount") != 150:
    raise SystemExit("VAKRA_DRY_RUN_GATE_FAIL")
fingerprint = json.load(open(run_root / "runtime-fingerprint.json", encoding="utf-8"))["runtimeFingerprint"]
if len(fingerprint["files"]["parser"]) != 122:
    raise SystemExit("FULL_SRC_COUNT_GATE_FAIL")
for records in fingerprint["files"].values():
    for record in records:
        current = hashlib.sha256((root / record["path"]).read_bytes()).hexdigest()
        if current != record["sha256"]:
            raise SystemExit(f"RUNTIME_DRIFT_GATE_FAIL path={record['path']}")
print("PRELAUNCH_METADATA_GATE_OK cap=16384 admission=16 domains=150")
PY
for container in \
  capability_1_bi_apis capability_2_dashboard_apis \
  capability_3_multihop_reasoning capability_4_multiturn; do
  if [[ $(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null) != true ]]; then
    echo "VAKRA_CONTAINER_GATE_FAIL container=$container" >&2
    exit 1
  fi
  docker exec "$container" test -r /app/mcp_dispatch.py || exit 1
done
echo "VAKRA_CONTAINER_GATE_OK capabilities=4"
if [[ -e "$OUTPUT_ROOT" || -L "$OUTPUT_ROOT" ]]; then
  echo "FRESH_OUTPUT_FAIL path=$OUTPUT_ROOT" >&2
  exit 1
fi

python3 "$WRAPPER" -- env \
  OPENAI_BRIDGE_OUTPUT="$BRIDGE_ROOT" \
  OPENAI_BRIDGE_PORT=8869 \
  OPENAI_BRIDGE_SUITE=vakra-full-5207-fresh-v11 \
  OPENAI_BRIDGE_MAX_OUTPUT_TOKENS=16384 \
  OPENAI_BRIDGE_TIMEOUT_MS=180000 \
  OPENAI_BRIDGE_TRANSIENT_RETRIES=4 \
  OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS=5000 \
  OPENAI_BRIDGE_TRANSPORT=generate \
  node --import "$REPO/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs" \
  "$BRIDGE" >"$BRIDGE_ROOT/bridge.log" 2>&1 &
bridge_pid=$!
echo "BRIDGE_FORK name=vakra pid=$bridge_pid port=8869"

for _ in $(seq 1 120); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8869/healthz > /tmp/vakra-v11-health.json; then
    echo "HEALTH_OK name=vakra port=8869 payload=$(tr -d '\n' </tmp/vakra-v11-health.json)"
    break
  fi
  sleep 0.25
done
if ! curl --fail --silent --max-time 2 http://127.0.0.1:8869/healthz >/dev/null; then
  echo "HEALTH_FAIL name=vakra port=8869" >&2
  exit 1
fi
for file in "$BRIDGE_ROOT/requests.jsonl" "$BRIDGE_ROOT/provider-raw.jsonl"; do
  if [[ ! -f "$file" || -s "$file" ]]; then
    echo "ZERO_GATE_FAIL file=$file" >&2
    exit 1
  fi
done
if [[ -e "$OUTPUT_ROOT" || -L "$OUTPUT_ROOT" ]]; then
  echo "FRESH_OUTPUT_FAIL path=$OUTPUT_ROOT" >&2
  exit 1
fi
echo "ZERO_GATE_OK bridgeRequestRows=0 bridgeProviderRows=0 historicalRowsReused=0"

python3 "$WRAPPER" -- env PYTHONUNBUFFERED=1 \
  /home/minpeter/.cache/glm52-benchmarks/vakra/.venv/bin/python \
  "$BENCH/vakra_official_native.py" \
  --code-root /home/minpeter/.cache/glm52-benchmarks/vakra \
  --manifest "$BRIDGE_ROOT/task-manifest.json" \
  --output-root "$OUTPUT_ROOT" --bridge-root "$BRIDGE_ROOT" \
  --python /home/minpeter/.cache/glm52-benchmarks/vakra/.venv/bin/python \
  --base-url http://127.0.0.1:8869/v1 --top-k-tools 128 \
  --agent-timeout-seconds 960 --child-log-mode discard --domain-sharding \
  --domain-workers-per-capability 2 --parallel-capabilities \
  >"$BRIDGE_ROOT/vakra-runner.log" 2>&1 &
runner_pid=$!
echo "RUNNER_FORK name=vakra pid=$runner_pid"
echo "ADMISSION_CONFIG_OK vakra=16 total=16"

while kill -0 "$runner_pid" 2>/dev/null; do
  echo "RUNNER_STATUS alive=1 vakra:$runner_pid:running"
  sleep 30
done
if wait "$runner_pid"; then
  echo "RUNNER_COMPLETE name=vakra exit=0"
  exit_code=0
else
  exit_code=$?
  echo "RUNNER_COMPLETE name=vakra exit=$exit_code" >&2
fi
kill -TERM "$bridge_pid" 2>/dev/null || true
wait "$bridge_pid" 2>/dev/null || true
exit "$exit_code"
