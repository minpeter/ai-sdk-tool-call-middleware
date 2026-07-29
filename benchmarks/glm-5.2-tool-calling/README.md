# GLM 5.2 tool-calling protocol benchmark

> **Current architecture (2026-07-19):** the `glm5` arm is prompt-only. It
> renders AI SDK function definitions into the official GLM-5.2 chat-template
> system text, sends `tools: []` with no provider `toolChoice`, and parses the
> generated text. Native-Plus/native-primary has been removed. Files, aliases,
> reports, and result directories that still contain `native-plus` are retained
> only as historical evidence; the live bridge rejects that legacy alias.

This harness compares every tool-call middleware shipped by this repository
with the provider-native path on the same model, prompts, schemas, and sampled
BFCL V4 cases.

It is a custom protocol-comparison panel, not an official BFCL leaderboard
submission. The common instruction, AI SDK schema conversion, category cap,
and middleware protocol-integrity checks are specific to this experiment.

## Design

- Model: `zai-org/glm-5.2`
- Arms: native, GLM-5.2 canonical protocol, Hermes, Morph XML, YAML XML,
  Qwen3Coder, Sijawara Detailed, Sijawara Concise, and UI-TARS
- BFCL V4 source: pinned separately and passed through `BFCL_ROOT`
- BFCL source commit: `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`
- Categories: 13 single-turn/static/live relevance categories
- Sampling: up to 40 cases per category, ranked by
  `SHA-256(seed + NUL + category + NUL + case ID)`
- Generation: temperature 0, automatic tool choice, 1,024 output tokens,
  120-second timeout, and provider retries
- Semantic score: BFCL's official AST checker
- Strict score: semantic correctness plus valid decoded arguments, no parser
  error, and no tool-protocol markup left in assistant text
- Provider failures: reported as availability, excluded only from conditional
  accuracy, and counted as incorrect in end-to-end accuracy and the primary
  paired test
- Paired scheduling: when both `native` and `glm5` are selected they are
  one sequential worker batch for every case/trial, with the leading arm
  hash-alternated by seed (these two arms are deliberately not imported from
  `BENCH_PRESEED_FROM`)
- Transport: `generate` (JSON) by default; `stream` exercises the true SSE
  path while keeping the same selected panel
- Raw provider evidence: credential-free request/response JSONL is captured
  for `native,glm5` by default and linked from each result row by capture ID

The Java and JavaScript BFCL schemas are converted to equivalent JSON Schema
for AI SDK inference. During scoring, their type labels are converted to
Python equivalents because AI SDK has already decoded arguments into JSON
values before the official checker receives them.

## Run

Do not put the API key in source files or result metadata.

```bash
export FREEROUTER_API_KEY='...'
export FREEROUTER_BASE_URL='https://freerouter.minpeter.workers.dev/v1'

BENCH_LIMIT_PER_CATEGORY=40 \
BENCH_CONCURRENCY=16 \
BENCH_PROVIDER_RETRIES=2 \
BENCH_SEED=52 \
BENCH_OUT=benchmarks/glm-5.2-tool-calling/results/run/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run.ts
```

For the paired Native versus GLM-5.2 parser experiment, freeze the same sample
and run non-streaming and streaming into separate directories:

```bash
BENCH_ARMS=native,glm5 \
BENCH_TRANSPORT=generate \
BENCH_LIMIT_PER_CATEGORY=40 \
BENCH_SEED=52 \
BENCH_OUT=benchmarks/glm-5.2-tool-calling/results/glm5-paired-json/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run.ts

BENCH_ARMS=native,glm5 \
BENCH_TRANSPORT=stream \
BENCH_LIMIT_PER_CATEGORY=40 \
BENCH_SEED=52 \
BENCH_OUT=benchmarks/glm-5.2-tool-calling/results/glm5-paired-sse/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run.ts
```

`BENCH_TRANSPORT` accepts `generate` or `stream`. Raw capture is enabled by
default and writes `provider-raw.jsonl` next to `BENCH_OUT`. The capture
allowlists non-secret transport headers, removes credential-like URL query
parameters, strips URL user-info, redacts the exact in-memory API key from
captured bodies/errors, and never stores the provider authorization header. It
does store benchmark prompts, schemas, and model output. Configuration:

| Variable | Default | Meaning |
|---|---:|---|
| `BENCH_ARMS` | all 9 | Comma-separated arm IDs, including `glm5` |
| `BENCH_TRANSPORT` | `generate` | `generate` for JSON or `stream` for SSE |
| `BENCH_RAW_CAPTURE` | `1` | Set to `0` to disable raw provider capture |
| `BENCH_RAW_CAPTURE_ARMS` | `native,glm5` | Arms whose provider exchanges are captured |
| `BENCH_RAW_CAPTURE_OUT` | beside `BENCH_OUT` | Raw capture JSONL path |
| `BENCH_DRY_RUN` | `0` | Set to `1` to validate source, sample grid, metadata, and fingerprint without a provider call or API key |

BFCL and ACE pin-check the local Git revision and store a canonical
`configFingerprint` in `run-meta.json`. The fingerprint includes the content
digest of the runner, scorer, analyzer, validator, production parser source,
package manifest, and lockfile. `BENCH_RESUME=1` refuses a missing or mismatched
metadata/output/capture set before modifying artifacts. A paired resume is also
refused if exactly one of Native/GLM is complete for any case; use a fresh
output directory so final pairs remain sequentially measured.

Re-run only the parser against captured provider bytes, without an API key or
network request:

```bash
pnpm dlx tsx \
  benchmarks/glm-5.2-tool-calling/src/replay-provider-capture.ts \
  --input benchmarks/glm-5.2-tool-calling/results/glm5-paired-sse/provider-raw.jsonl \
  --out benchmarks/glm-5.2-tool-calling/results/glm5-paired-sse/replayed.jsonl \
  --arms native,glm5 \
  --parser auto \
  --suite bfcl
```

The replay tool drives the two current response semantics: plain provider calls
for `native` and canonical prompt-only GLM text parsing for `glm5`. It records
parser diagnostics and raw-body/text SHA-256 hashes, reparses deterministic SSE
byte splits, and re-chunks text/tool-input deltas through the production GLM
stream parser. The normalized call, text, and lifecycle snapshot must remain
exactly identical or the replay fails. Use `--parser native` or `--parser glm5`
for explicit diagnostics.

An offline fixture covers one native JSON call and one GLM SSE call split
inside `<tool_call>`:

```bash
pnpm dlx tsx \
  benchmarks/glm-5.2-tool-calling/src/replay-provider-capture.ts \
  --input benchmarks/glm-5.2-tool-calling/fixtures/provider-capture-smoke.jsonl \
  --out /tmp/glm5-provider-replay-smoke.jsonl \
  --parser auto
```

Validate that provider credentials are absent and every result capture ID is
resolvable. When the live API key remains exported, its exact value is checked
without being printed:

```bash
python3 benchmarks/glm-5.2-tool-calling/validate_provider_capture.py \
  --capture benchmarks/glm-5.2-tool-calling/results/glm5-paired-sse/provider-raw.jsonl \
  --result-raw benchmarks/glm-5.2-tool-calling/results/glm5-paired-sse/raw.jsonl \
  --expected-arms native,glm5
```

Resume missing jobs and retry transport failures:

```bash
BENCH_RESUME=1 \
BENCH_RETRY_FAILED=1 \
BENCH_LIMIT_PER_CATEGORY=40 \
BENCH_CONCURRENCY=16 \
BENCH_OUT=benchmarks/glm-5.2-tool-calling/results/run/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run.ts
```

## Score, analyze, and validate

```bash
python3 benchmarks/glm-5.2-tool-calling/score_bfcl.py \
  --raw benchmarks/glm-5.2-tool-calling/results/run/raw.jsonl \
  --out benchmarks/glm-5.2-tool-calling/results/run/scored.jsonl \
  --bfcl-root "$BFCL_ROOT"

BENCH_SCORED=benchmarks/glm-5.2-tool-calling/results/run/scored.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/analyze.ts

python3 benchmarks/glm-5.2-tool-calling/validate_bfcl.py \
  --raw benchmarks/glm-5.2-tool-calling/results/run/raw.jsonl \
  --scored benchmarks/glm-5.2-tool-calling/results/run/scored.jsonl \
  --meta benchmarks/glm-5.2-tool-calling/results/run/run-meta.json
```

The analysis step writes JSON/CSV summaries and SVG charts. Render deterministic
PNG copies for systems such as Notion that do not reliably render SVG:

```bash
python3 benchmarks/glm-5.2-tool-calling/render_svg_charts.py \
  --chart-dir benchmarks/glm-5.2-tool-calling/results/run/charts \
  --report benchmarks/glm-5.2-tool-calling/results/run/chart-rendering.json
```

The paired summary's primary exact McNemar test uses matched end-to-end strict
outcomes, so provider and parser failures remain failures. Conditional strict
and official-semantic paired counts are preserved separately for diagnosis.

## ACEBench-derived bilingual validation

The ACE panel is an independent bilingual protocol comparison, not an
official ACEBench leaderboard submission. It uses the official Normal static
checker but sends the same AI SDK tool schemas through every protocol instead
of ACEBench's original AST-format inference prompt.

- Source commit: `56dd66cf6439b0d9655ee1b353e4cd745c6f664e`
- Panel: English and Chinese, 10 Normal static categories, 5 cases per
  language/category stratum
- Sampling: rank oracle-valid rows by
  `SHA-256(seed + NUL + commit + NUL + language + NUL + category + NUL + ID)`
- Size: 100 cases × 9 protocol arms = 900 jobs by default
- Source-quality guard: eight rows whose own ground truth fails the pinned
  official checker are verified and excluded before sampling
- Protocol-strict score: pinned-checker semantic correctness plus valid decoded
  argument objects, no parser error or markup leak, and no leading/trailing
  argument whitespace when the oracle data contains none. This guards against
  the ACE checker's permissive ASCII-space standardization and substring string
  matching hiding XML parser corruption.

```bash
BENCH_CONCURRENCY=16 \
BENCH_PROVIDER_RETRIES=2 \
BENCH_SEED=52 \
BENCH_OUT=benchmarks/glm-5.2-tool-calling/results/ace-run/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-ace.ts

python3 benchmarks/glm-5.2-tool-calling/score_ace.py \
  --raw benchmarks/glm-5.2-tool-calling/results/ace-run/raw.jsonl \
  --out benchmarks/glm-5.2-tool-calling/results/ace-run/scored.jsonl \
  --ace-root "$ACE_ROOT"

python3 benchmarks/glm-5.2-tool-calling/analyze_ace.py \
  --scored benchmarks/glm-5.2-tool-calling/results/ace-run/scored.jsonl \
  --out-dir benchmarks/glm-5.2-tool-calling/results/ace-run

python3 benchmarks/glm-5.2-tool-calling/validate_ace.py \
  --raw benchmarks/glm-5.2-tool-calling/results/ace-run/raw.jsonl \
  --scored benchmarks/glm-5.2-tool-calling/results/ace-run/scored.jsonl \
  --meta benchmarks/glm-5.2-tool-calling/results/ace-run/run-meta.json
```

ACE accepts the same `BENCH_ARMS`, `BENCH_TRANSPORT`, and raw-capture
variables. Use `BENCH_ARMS=native,glm5` to run the paired panel on exactly the
same bilingual sample.

## Diagnostic sensitivity analyses

Sensitivity results are not observed benchmark scores. In particular, the
Sijawara whitespace diagnostic recursively trims decoded string arguments and
re-runs the official BFCL checker to estimate how much of the observed error
could come from XML indentation leaking into string values. Preserve the
original scored file and label this counterfactual separately.

```bash
BENCH_SCORED=benchmarks/glm-5.2-tool-calling/results/run/scored.jsonl \
BENCH_SENSITIVITY_SCORED=/tmp/bfcl-sijawara-trimmed-scored.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/analyze.ts
```

## MCPMark Filesystem Easy multi-turn validation

The MCPMark runner executes the same nine arms against the official 10-task
Filesystem Easy smoke/CI slice. Each job receives a fresh hash-verified
snapshot, drives the pinned filesystem MCP server through a manual multi-turn
loop, and is scored by the pinned official verifier. It is an adapted protocol
panel, not the 127-task MCPMark Verified leaderboard configuration.

See [`MCPMARK.md`](./MCPMARK.md) for the pinned source, security controls,
offline infrastructure pilot, full run, resume, analysis, and validation
commands.

## Historical Native-Plus cross-suite report (retired)

This section and `report_native_plus.py` are retained only to reproduce the
archived 2026-07-17 report. They do not describe or benchmark the current
product path and must not be used as evidence for `glm5ToolMiddleware`.

```bash
python3 benchmarks/glm-5.2-tool-calling/report_native_plus.py \
  --bfcl-dir benchmarks/glm-5.2-tool-calling/results/native-plus-bfcl \
  --ace-dir benchmarks/glm-5.2-tool-calling/results/native-plus-ace \
  --mcpmark-dir benchmarks/glm-5.2-tool-calling/results/native-plus-mcpmark \
  --out-dir benchmarks/glm-5.2-tool-calling/results/native-plus-cross-report \
  --native-arm native \
  --plus-arm glm5
```

The archived scheduler used names that no longer exist in the product. Current
fresh runs use only `native` and prompt-only `glm5` and require new result
directories.

BFCL must contain `summary.json` and `scored.jsonl`; ACE must contain
`ace-summary.json` and `scored.jsonl`; MCPMark must contain
`mcpmark-summary.json` and `raw.jsonl`. The output includes PNG+SVG accuracy,
paired-change, and latency/token charts, cross-suite CSV/JSON, and a concise
Notion-ready Markdown summary. Different suite scores are never pooled. A
dollar cost is preserved only if the input explicitly supplies a USD cost
field; it is never inferred from token counts.

Run the fixture-backed CLI smoke test with:

```bash
python3 benchmarks/glm-5.2-tool-calling/test_report_native_plus.py -v
```

## GLM deployment-reference parser replay

The offline reference replay compares the production `glm5Protocol` generate
and stream paths with three pinned deployment references: vLLM Rust GLM47,
vLLM Python GLM47, and SGLang GLM47. These references do **not** identify the
parser used by FreeRouter. The natural arm consumes only previously captured
Canonical response bytes and never needs an API key or makes a provider call.

By default it replays the full Canonical BFCL 456-case capture, ACE 100-case
capture, and the 13-case real-SSE BFCL capture. It also runs a separately
labeled official-template-derived conformance/corruption corpus. The CLI emits
scorer-compatible raw JSONL, BFCL/ACE scored JSONL, per-case details, CSV
summaries, and `summary.json`:

```bash
pnpm dlx tsx \
  benchmarks/glm-5.2-tool-calling/src/replay-glm5-reference-parsers.ts \
  --out-dir benchmarks/glm-5.2-tool-calling/results/glm5-reference-replay \
  --generated-at 2026-07-17T08:08:47.112Z \
  --bfcl-root /tmp/bfcl-research/berkeley-function-call-leaderboard \
  --ace-root /tmp/acebench-function-calling
```

Use `--skip-score` when only parser acceptance, exact-call comparison,
false-positive labels, and generate/stream/chunk invariance are needed. Input
captures can be overridden with `--bfcl-capture`, `--bfcl-raw`,
`--ace-capture`, `--ace-raw`, `--sse-capture`, and `--sse-raw`.
Pass a timezone-qualified ISO timestamp with `--generated-at` to make the
complete artifact byte-reproducible; the CLI validates and normalizes it to
UTC in `summary.json`.
