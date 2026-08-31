# GLM-5.2 Native vs Native-Plus: fresh generate runbook

> **사용 중지 (2026-07-19):** Native‑Plus/native-primary 제거 전 실행 절차를
> 보존한 문서다. 현재 fresh 측정에는 사용하지 말고, `src/run.ts`의 `native`
> 대 prompt-only `glm5` arm으로 새 출력 디렉터리에서 실행해야 한다.

이 문서는 같은 샘플에서 `native,glm5` 두 arm만 실행하는 non-streaming
(`generate`, provider JSON) 실측 명령을 고정한다. API 키 값은 파일이나 명령
인자에 넣지 않고 현재 셸 환경에만 둔다.

## 공통 환경

```bash
set -o pipefail
export FREEROUTER_API_KEY='<set-in-shell>'
export FREEROUTER_BASE_URL='https://freerouter.minpeter.workers.dev/v1'
export BENCH_MODEL='zai-org/glm-5.2'
export BFCL_ROOT='/tmp/bfcl-research/berkeley-function-call-leaderboard'
export BFCL_COMMIT='6ea57973c7a6097fd7c5915698c54c17c5b1b6c8'
export ACE_ROOT='/tmp/acebench-function-calling'
export MCPMARK_ROOT='/tmp/mcpmark-research'
export MCPMARK_DATA_ROOT='/tmp/mcpmark-filesystem-data'
export MCPMARK_SNAPSHOT_ROOT='/tmp/mcpmark-filesystem-runs'

git -C "$BFCL_ROOT" rev-parse HEAD
git -C "$ACE_ROOT" rev-parse HEAD
git -C "$MCPMARK_ROOT" rev-parse HEAD
```

필요한 revision은 각각 다음과 같다.

- BFCL: `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`
- ACEBench: `56dd66cf6439b0d9655ee1b353e4cd745c6f664e`
- MCPMark: `cd45b7f57923b9b3985467f5139927575f83141c`

러너도 이 revision을 직접 검사한다.

## 검증된 zero-provider preflight

실측 폴더와 분리된 `/tmp/glm5-native-plus-v3-preflight` 아래에서 아래 세
live 명령을 그대로 사용하되, credential을 명시적으로 제거하고 dry-run만
활성화한다.

기존 `/tmp/glm5-native-plus-v2-preflight`와 `*-v2` run ID는 τ³ bridge가
implementation fingerprint 입력에 추가되기 전 결과다. 해당 meta는 현재
checkout에서 stale이므로 live resume에 사용하지 않는다.

```bash
PREFLIGHT_ROOT='/tmp/glm5-native-plus-v3-preflight'
env -u FREEROUTER_API_KEY BENCH_DRY_RUN=1 ... pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run.ts
env -u FREEROUTER_API_KEY BENCH_DRY_RUN=1 ... pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-ace.ts
env -u FREEROUTER_API_KEY MCPMARK_DRY_RUN=1 ... pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-mcpmark.ts
```

각 `...`에는 아래 live 명령의 suite별 환경변수를 그대로 넣고 output만
`$PREFLIGHT_ROOT/<동일-run-id>/{raw,provider-raw}.jsonl`로 바꾼다. 검증된
기대치는 BFCL `456/912`, ACE `100/200`, MCPMark `10/20`이며 총 1,132
jobs다. 2026-07-17 v3 preflight의 implementation fingerprint는
`2df75acd295d2c6597c0f42731038278ac58217be678d3176db211c70b4d380a`였다.
Suite별 configuration fingerprint는 BFCL
`6ef33882db73884c5fed20fd77e1e2c6af90839be891d0f33a2dc73544900e0b`,
ACE `4e329a85ddfeaff7035f5308e4c63c84d7221ac16c37685082bdd7c0696374c1`,
MCPMark `c6bee9d02db178fc8c69cbbc3c38b3095d3d26201feffe4219c2e2ded45b8ef4`다.

동일 설정 resume는 BFCL/ACE에 `BENCH_RESUME=1`, MCPMark에
`MCPMARK_RESUME=1`을 추가해 성공해야 한다. 이어서 arm만 `native`로 바꾼
negative test는 세 suite 모두 configuration fingerprint mismatch로 실패해야
한다. 마지막으로 provider artifact가 비어 있는지 검사한다.

```bash
find "$PREFLIGHT_ROOT" -maxdepth 2 -type f \
  \( -name raw.jsonl -o -name provider-raw.jsonl \) \
  -printf '%p %s bytes\n' | sort

env -u FREEROUTER_API_KEY pnpm dlx tsx -e \
  'import { benchmarkImplementationFingerprint } from "./benchmarks/glm-5.2-tool-calling/src/run-resume-integrity.ts"; process.stdout.write(benchmarkImplementationFingerprint()+"\n")'
```

여섯 JSONL 파일이 모두 0 bytes여야 한다. dry-run meta에는 `dryRun=true`가
fingerprint에 포함되므로 실측으로 resume하지 않고, 실측은 반드시 아래의
새 빈 결과 폴더에서 시작한다.

## BFCL V4 456 cases x 2 arms

```bash
BFCL_RUN='benchmarks/glm-5.2-tool-calling/results/2026-07-17-glm5-native-plus-bfcl-v4-456-generate-v3'

BENCH_DRY_RUN=0 \
BENCH_ARMS=native,glm5 \
BENCH_TRANSPORT=generate \
BENCH_CATEGORIES=simple_python,multiple,parallel,parallel_multiple,simple_java,simple_javascript,irrelevance,live_simple,live_multiple,live_parallel,live_parallel_multiple,live_irrelevance,live_relevance \
BENCH_LIMIT_PER_CATEGORY=40 \
BENCH_TRIALS=1 \
BENCH_SEED=52 \
BENCH_CONCURRENCY=16 \
BENCH_PROVIDER_RETRIES=2 \
BENCH_TIMEOUT_MS=120000 \
BENCH_RAW_CAPTURE=1 \
BENCH_RAW_CAPTURE_ARMS=native,glm5 \
BENCH_OUT="$BFCL_RUN/raw.jsonl" \
BENCH_RAW_CAPTURE_OUT="$BFCL_RUN/provider-raw.jsonl" \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run.ts

python3 benchmarks/glm-5.2-tool-calling/score_bfcl.py \
  --raw "$BFCL_RUN/raw.jsonl" \
  --out "$BFCL_RUN/scored.jsonl" \
  --bfcl-root "$BFCL_ROOT"

BENCH_SCORED="$BFCL_RUN/scored.jsonl" \
BENCH_ANALYSIS_OUT="$BFCL_RUN" \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/analyze.ts

python3 benchmarks/glm-5.2-tool-calling/validate_bfcl.py \
  --raw "$BFCL_RUN/raw.jsonl" \
  --scored "$BFCL_RUN/scored.jsonl" \
  --meta "$BFCL_RUN/run-meta.json" | tee "$BFCL_RUN/validation.json"

python3 benchmarks/glm-5.2-tool-calling/validate_provider_capture.py \
  --capture "$BFCL_RUN/provider-raw.jsonl" \
  --result-raw "$BFCL_RUN/raw.jsonl" \
  --expected-arms native,glm5 | tee "$BFCL_RUN/capture-validation.json"

python3 benchmarks/glm-5.2-tool-calling/render_svg_charts.py \
  --chart-dir "$BFCL_RUN/charts" \
  --report "$BFCL_RUN/chart-rendering.json"
```

예상 메타 그리드는 `expectedCases=456`, `expectedJobs=912`이다.

## ACE Normal 100 cases x 2 arms

```bash
ACE_RUN='benchmarks/glm-5.2-tool-calling/results/2026-07-17-glm5-native-plus-ace-normal-100-generate-v3'

BENCH_DRY_RUN=0 \
BENCH_ARMS=native,glm5 \
BENCH_TRANSPORT=generate \
BENCH_SEED=52 \
BENCH_CONCURRENCY=16 \
BENCH_PROVIDER_RETRIES=2 \
BENCH_TIMEOUT_MS=120000 \
BENCH_RAW_CAPTURE=1 \
BENCH_RAW_CAPTURE_ARMS=native,glm5 \
BENCH_OUT="$ACE_RUN/raw.jsonl" \
BENCH_RAW_CAPTURE_OUT="$ACE_RUN/provider-raw.jsonl" \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-ace.ts

python3 benchmarks/glm-5.2-tool-calling/score_ace.py \
  --raw "$ACE_RUN/raw.jsonl" \
  --out "$ACE_RUN/scored.jsonl" \
  --ace-root "$ACE_ROOT"

python3 benchmarks/glm-5.2-tool-calling/analyze_ace.py \
  --scored "$ACE_RUN/scored.jsonl" \
  --out-dir "$ACE_RUN"

python3 benchmarks/glm-5.2-tool-calling/validate_ace.py \
  --raw "$ACE_RUN/raw.jsonl" \
  --scored "$ACE_RUN/scored.jsonl" \
  --meta "$ACE_RUN/run-meta.json" | tee "$ACE_RUN/validation.json"

python3 benchmarks/glm-5.2-tool-calling/validate_provider_capture.py \
  --capture "$ACE_RUN/provider-raw.jsonl" \
  --result-raw "$ACE_RUN/raw.jsonl" \
  --expected-arms native,glm5 | tee "$ACE_RUN/capture-validation.json"

python3 benchmarks/glm-5.2-tool-calling/render_svg_charts.py \
  --chart-dir "$ACE_RUN/charts" \
  --report "$ACE_RUN/chart-rendering.json"
```

예상 메타 그리드는 `expectedCases=100`, `expectedJobs=200`이다.

## MCPMark Filesystem Easy 10 tasks x 2 arms

```bash
MCP_RUN='benchmarks/glm-5.2-tool-calling/results/2026-07-17-glm5-native-plus-mcpmark-filesystem-easy-10-generate-v3'

MCPMARK_DRY_RUN=0 \
MCPMARK_ARMS=native,glm5 \
MCPMARK_TRANSPORT=generate \
MCPMARK_TASKS=file_context/file_splitting,file_context/pattern_matching,file_context/uppercase,file_property/largest_rename,file_property/txt_merging,folder_structure/structure_analysis,legal_document/file_reorganize,papers/papers_counting,student_database/duplicate_name,student_database/recommender_name \
MCPMARK_TRIALS=1 \
MCPMARK_PAIR_SEED=52 \
MCPMARK_CONCURRENCY=4 \
MCPMARK_RETRIES=2 \
MCPMARK_MAX_TURNS=100 \
MCPMARK_MAX_OUTPUT_TOKENS=4096 \
MCPMARK_PROVIDER_TIMEOUT_MS=120000 \
MCPMARK_MCP_TIMEOUT_MS=60000 \
MCPMARK_VERIFIER_TIMEOUT_MS=120000 \
MCPMARK_ATTEMPT_TIMEOUT_MS=600000 \
MCPMARK_KEEP_SNAPSHOTS=failed \
MCPMARK_RAW_CAPTURE=1 \
MCPMARK_RAW_CAPTURE_ARMS=native,glm5 \
MCPMARK_OUT="$MCP_RUN/raw.jsonl" \
MCPMARK_RAW_CAPTURE_OUT="$MCP_RUN/provider-raw.jsonl" \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-mcpmark.ts

python3 benchmarks/glm-5.2-tool-calling/validate_mcpmark.py \
  --raw "$MCP_RUN/raw.jsonl" \
  --meta "$MCP_RUN/run-meta.json" | tee "$MCP_RUN/validation.json"

python3 benchmarks/glm-5.2-tool-calling/analyze_mcpmark.py \
  --raw "$MCP_RUN/raw.jsonl" \
  --meta "$MCP_RUN/run-meta.json" \
  --out-dir "$MCP_RUN"

python3 benchmarks/glm-5.2-tool-calling/validate_provider_capture.py \
  --capture "$MCP_RUN/provider-raw.jsonl" \
  --result-raw "$MCP_RUN/raw.jsonl" \
  --expected-arms native,glm5 | tee "$MCP_RUN/capture-validation.json"
```

MCPMark는 실행 중 official verifier로 score된다. 예상 메타 그리드는
`10 tasks`, `expectedJobs=20`이다.

## Resume 안전성

각 `run-meta.json`에는 canonical `configFingerprint`가 저장된다. 여기에는
model, endpoint, arm, case/task grid, seed, transport, timeout, capture 설정뿐
아니라 runner/scorer/analyzer/validator, production parser 및 lockfile의 실제
내용 digest도 포함된다. 하나라도 달라지면 raw/capture를 수정하기 전에
중단한다. Dry-run 메타는 `dryRun=true`이므로 실측으로 resume할 수 없다.

Native/GLM pair는 한 worker batch 안에서 hash-alternated 순서로 순차 실행된다.
Resume 상태에서 한 arm만 완료됐거나 `*_RETRY_FAILED=1` 때문에 한 arm만 다시
실행해야 하면 러너가 중단한다. 이런 경우 새 출력 폴더에서 전체 pair를 다시
실행한다. 남은 provider 실패는 conditional accuracy에서는 제외되지만 primary
end-to-end strict score와 exact McNemar에서는 실패로 포함한다.

## 최종 보고서 입력

- 공통: `raw.jsonl`, `run-meta.json`, `provider-raw.jsonl`,
  `capture-validation.json`, `validation.json`
- BFCL/ACE: `scored.jsonl`, protocol/category/language/failure/paired CSV,
  summary JSON, SVG 및 PNG charts, `chart-rendering.json`
- MCPMark: `mcpmark-summary.json`, protocol/task/paired/failure CSV,
  SVG 및 PNG charts
- 교차 비교: `analyze_cross.py`가 생성하는
  `cross-benchmark-summary.{json,csv}`와 `cross-benchmark-accuracy.svg`
- parser-only 근거: `replay-provider-capture.ts` 결과와 raw-body/text SHA-256

Raw capture에는 benchmark prompt와 model output은 포함되지만 Authorization
header는 포함되지 않는다. Capture validator는 현재 환경의 credential 값도
값을 출력하지 않고 대조한다.

```bash
CROSS_RUN='benchmarks/glm-5.2-tool-calling/results/2026-07-17-glm5-native-plus-cross-generate-v3'
python3 benchmarks/glm-5.2-tool-calling/analyze_cross.py \
  --bfcl-summary "$BFCL_RUN/summary.json" \
  --ace-summary "$ACE_RUN/ace-summary.json" \
  --out-dir "$CROSS_RUN"

python3 benchmarks/glm-5.2-tool-calling/render_svg_charts.py \
  --chart-dir "$CROSS_RUN" \
  --report "$CROSS_RUN/chart-rendering.json"

python3 benchmarks/glm-5.2-tool-calling/report_native_plus.py \
  --bfcl-dir "$BFCL_RUN" \
  --ace-dir "$ACE_RUN" \
  --mcpmark-dir "$MCP_RUN" \
  --out-dir "$CROSS_RUN/native-plus-report" \
  --native-arm native \
  --plus-arm glm5
```

`glm5`가 현재 production `glm5NativePlusToolMiddleware` arm이다.
`glm5Repair`는 이 paired scheduler의 arm이 아니므로 보고서 입력으로 사용하지
않는다.
