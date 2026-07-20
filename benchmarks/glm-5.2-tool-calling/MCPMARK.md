# MCPMark Filesystem Easy protocol panel

This runner compares the same nine tool-call arms used by the BFCL and ACE
panels on MCPMark's official Filesystem Easy tasks:

- provider-native tool calls
- GLM-5.2 canonical tool-call protocol
- Hermes
- Morph XML
- YAML XML
- Qwen3Coder
- Sijawara Detailed XML
- Sijawara Concise XML
- UI-TARS

Filesystem Easy contains 10 tasks and is described by MCPMark as a smoke/CI
slice. It is **not** the 127-task MCPMark Verified standard leaderboard. Treat
results as an adapted, official-verifier-backed protocol comparison on the
Easy slice, not as a standard MCPMark leaderboard score. The inference loop,
model, temperature, token limit, and protocol middleware are specific to this
experiment.

## Reproducibility pins

- MCPMark commit: `cd45b7f57923b9b3985467f5139927575f83141c`
- Filesystem server: `@modelcontextprotocol/server-filesystem@2025.12.18`
- Six dataset ZIP SHA-256 values are hard-coded in
  `src/mcpmark-filesystem-common.ts` and checked before extraction.
- Every task/arm/trial/retry receives a fresh copy-on-write snapshot.
- The effective task prompt preserves the `description.md` bytes and appends
  the exact suffix used by the pinned upstream `BaseTaskManager`; its SHA-256
  is stored per task.
- The official task `verify.py` runs after every attempt, including agent
  failures.
- Every job re-lists the MCP tools and checks the schema fingerprint captured
  during the run preflight.
- Provider credentials are removed from the environment of the MCP server,
  verifier, and all other child processes.
- Resume is refused unless the previous metadata has the same configuration
  fingerprint, including model, endpoint, tasks, hashes, schema, limits, and
  the content digest of runner/analyzer/parser source plus the lockfile.

The default `/tmp` ZIP cache accepts either `mcpmark-<category>.zip` or
`<category>.zip`, but only after the pinned hash matches. Otherwise the runner
downloads from the official MCPMark storage URL and verifies the result.

## Offline setup pilot

This makes zero model or provider calls. It uses MCP tools to inspect and
rename the largest JPG for `largest_rename`, then reads and rewrites five files
for `uppercase`. Both official verifiers must pass and both MCP server instances
must expose the same schema fingerprint.

```bash
MCPMARK_ROOT=/tmp/mcpmark-research \
MCPMARK_PILOT_OUT=/tmp/mcpmark-offline-pilot.json \
pnpm dlx tsx \
  benchmarks/glm-5.2-tool-calling/src/pilot-mcpmark-offline.ts
```

The output is explicitly labeled `offline-infrastructure-self-test`; it is not
benchmark evidence about a model.

## Run the model panel

Keep the API key in the environment, never in source or result metadata.

```bash
export FREEROUTER_API_KEY='...'
export FREEROUTER_BASE_URL='https://freerouter.minpeter.workers.dev/v1'

MCPMARK_ROOT=/tmp/mcpmark-research \
MCPMARK_CONCURRENCY=4 \
MCPMARK_RETRIES=2 \
MCPMARK_TRIALS=1 \
MCPMARK_OUT=benchmarks/glm-5.2-tool-calling/results/mcpmark-run/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-mcpmark.ts
```

Run the paired Native versus GLM-5.2 arms on the same task/trial schedule:

```bash
MCPMARK_ARMS=native,glm5 \
MCPMARK_TRANSPORT=stream \
MCPMARK_PAIR_SEED=52 \
MCPMARK_OUT=benchmarks/glm-5.2-tool-calling/results/mcpmark-glm5-sse/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-mcpmark.ts
```

The pair runs sequentially in one worker batch per task/trial and the leading
arm is hash-alternated. Other task batches may still execute concurrently.
Use `MCPMARK_TRANSPORT=generate` for the non-streaming JSON run. Raw JSON/SSE
capture defaults to `provider-raw.jsonl` beside `MCPMARK_OUT`; it omits
provider credentials and captures `native,glm5` unless configured otherwise.

Run a two-task smoke across all protocols first:

```bash
MCPMARK_TASKS=file_property/largest_rename,file_context/uppercase \
MCPMARK_ARMS=native,glm5,hermes,morphXml,yamlXml,qwen3Coder,sijawaraDetailed,sijawaraConcise,uiTars \
MCPMARK_CONCURRENCY=4 \
MCPMARK_OUT=benchmarks/glm-5.2-tool-calling/results/mcpmark-smoke/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-mcpmark.ts
```

Resume missing jobs and optionally rerun jobs whose latest official verifier
result failed:

```bash
MCPMARK_RESUME=1 \
MCPMARK_RETRY_FAILED=1 \
MCPMARK_OUT=benchmarks/glm-5.2-tool-calling/results/mcpmark-run/raw.jsonl \
pnpm dlx tsx benchmarks/glm-5.2-tool-calling/src/run-mcpmark.ts
```

For a Native/GLM paired run, resume is intentionally rejected when only one
arm of a task/trial would be rerun. Start a fresh output directory in that case;
mixing a later retry with an earlier partner would defeat the paired schedule.

## Important settings

| Variable | Default | Meaning |
|---|---:|---|
| `MCPMARK_TASKS` | all 10 | Comma-separated `category/task` IDs |
| `MCPMARK_ARMS` | all 9 | Comma-separated protocol arm IDs |
| `MCPMARK_TRANSPORT` | `generate` | `generate` for JSON or `stream` for SSE |
| `MCPMARK_PAIR_SEED` | `52` | Hash seed that alternates the paired leading arm |
| `MCPMARK_TRIALS` | `1` | Independent trials per task/arm |
| `MCPMARK_CONCURRENCY` | `4` | Concurrent isolated jobs |
| `MCPMARK_RETRIES` | `2` | Whole-job retries after provider or infrastructure failure |
| `MCPMARK_MAX_TURNS` | `100` | Maximum model turns per attempt |
| `MCPMARK_MAX_OUTPUT_TOKENS` | `4096` | Maximum output tokens per turn |
| `MCPMARK_PROVIDER_TIMEOUT_MS` | `120000` | Timeout for each model turn |
| `MCPMARK_ATTEMPT_TIMEOUT_MS` | `600000` | Whole agent-attempt time budget |
| `MCPMARK_MCP_TIMEOUT_MS` | `60000` | Timeout for each MCP request |
| `MCPMARK_VERIFIER_TIMEOUT_MS` | `120000` | Official verifier timeout |
| `MCPMARK_KEEP_SNAPSHOTS` | `failed` | `all`, `failed`, or `none` |
| `MCPMARK_RAW_CAPTURE` | `1` | Set to `0` to disable provider capture |
| `MCPMARK_RAW_CAPTURE_ARMS` | `native,glm5` | Captured arm IDs |
| `MCPMARK_RAW_CAPTURE_OUT` | beside `MCPMARK_OUT` | Raw provider JSONL path |
| `MCPMARK_DRY_RUN` | `0` | Set to `1` for source/data/schema/grid preflight without a provider call or API key |
| `MCPMARK_DATA_ROOT` | `/tmp/mcpmark-filesystem-data` | Hash-checked pristine data |
| `MCPMARK_SNAPSHOT_ROOT` | `/tmp/mcpmark-filesystem-runs` | Per-attempt snapshots |

Every JSONL row retains all attempt trajectories. Each turn includes parser
errors, assistant response messages, token usage, tool inputs, exact serialized
MCP results, and result hashes. Failure records distinguish setup, provider,
parser, MCP, turn-limit, and verification failures. Retries are only triggered
by records marked as provider/infrastructure failures; parser errors, ordinary
tool `isError` responses, turn limits, and verifier failures are not silently
replayed.

## Validate and analyze

```bash
python3 benchmarks/glm-5.2-tool-calling/validate_mcpmark.py \
  --raw benchmarks/glm-5.2-tool-calling/results/mcpmark-run/raw.jsonl \
  --meta benchmarks/glm-5.2-tool-calling/results/mcpmark-run/run-meta.json

python3 benchmarks/glm-5.2-tool-calling/analyze_mcpmark.py \
  --raw benchmarks/glm-5.2-tool-calling/results/mcpmark-run/raw.jsonl \
  --meta benchmarks/glm-5.2-tool-calling/results/mcpmark-run/run-meta.json \
  --out-dir benchmarks/glm-5.2-tool-calling/results/mcpmark-run
```

The validator checks the exact task/arm/trial grid, metadata and output hashes,
schema consistency, retry recovery, and secret patterns. Official verifier
failures are model outcomes, while unrecovered final-attempt provider or setup
failures are integrity errors. The analyzer emits JSON/CSV summaries and SVG +
PNG charts for success, task coverage, execution footprint, and primary failure
composition.

Replay captured calls offline with the same CLI documented in `README.md`,
using `--suite mcpmark`. No provider API key is needed for replay.
