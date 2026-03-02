# StagePilot Multi-Agent Skeleton

This repository now includes a hackathon-oriented, Google-only orchestration skeleton under `src/stagepilot`.

## What it includes
- Ontology snapshot builder (`buildOntologySnapshot`)
- Multi-agent flow:
  - `EligibilityAgent`
  - `SafetyAgent`
  - `PlannerAgent`
  - `OutreachAgent`
  - `JudgeAgent`
- Optional Gemini summarization gateway (`GeminiGateway`)
- Orchestrator (`StagePilotEngine`)
- Digital-twin style what-if simulator (`simulateStagePilotTwin`)

## Files
- `src/stagepilot/types.ts`
- `src/stagepilot/ontology.ts`
- `src/stagepilot/agents.ts`
- `src/stagepilot/orchestrator.ts`
- `src/stagepilot/twin.ts`
- `src/api/stagepilot-server.ts`
- `src/bin/stagepilot-api.ts`
- `src/examples/stagepilot-run.ts`
- `tests/stagepilot-ontology.test.ts`
- `tests/stagepilot-orchestrator.test.ts`
- `tests/stagepilot-twin.test.ts`

## Run example
```bash
npx tsx src/examples/stagepilot-run.ts
```

If `GEMINI_API_KEY` and `GEMINI_MODEL` are present, the orchestrator attempts an LLM summary.
Gemini HTTP calls are guarded by `GEMINI_HTTP_TIMEOUT_MS` (default `8000`, clamped).
If not, it uses deterministic fallback output.

## API (Cloud Run target)

Run local API:

```bash
npm run api:stagepilot
```

Routes:
- `GET /demo` (judge desktop UI)
- `GET /health`
- `POST /v1/plan`
- `POST /v1/benchmark`
- `POST /v1/insights`
- `POST /v1/whatif`
- `POST /v1/notify`
- `POST /v1/openclaw/inbox`

Error status behavior:
- `400` malformed JSON or invalid request shape
- `408` request body upload timeout (full upload budget via `STAGEPILOT_REQUEST_BODY_TIMEOUT_MS`, default `10000`)
- `413` request body too large (> 1MB)
- `415` non-JSON `Content-Type` for POST requests

`/v1/insights` behavior:
- derives ontology KPI signals from current case graph (referrals, top programs, SLA)
- when `GEMINI_API_KEY` is set, uses `GEMINI_MODEL` (e.g. `gemini-3.1-pro-preview`) for narrative insight bullets
- Gemini HTTP timeout is controlled by `GEMINI_HTTP_TIMEOUT_MS` (default `8000`)
- if Gemini call fails, falls back to deterministic insight narrative

`/v1/whatif` behavior:
- runs normal orchestration first (`/v1/plan` equivalent)
- applies scenario deltas for operations simulation:
  - `scenario.staffingDeltaPct` (e.g. `-20`)
  - `scenario.demandDeltaPct` (e.g. `+30`)
  - `scenario.contactRateDeltaPct` (e.g. `+10`)
- optionally applies profile calibration values:
  - `profile.avgHandleMinutes`
  - `profile.backlogCases`
  - `profile.caseWorkers`
  - `profile.demandPerHour`
  - `profile.contactSuccessRate`
- returns:
  - baseline vs simulated queue/SLA metrics
  - recommended routing option
  - alternatives list for operator decision support

`/v1/notify` behavior:
- runs orchestration from intake payload (`/v1/plan` equivalent)
- optionally runs twin simulation when `scenario` or `profile` is provided
- builds operator briefing text (case summary + top routes + first actions + twin recommendation)
- dispatches through OpenClaw bridge:
  - webhook mode (`OPENCLAW_WEBHOOK_URL`)
  - webhook path is guarded by timeout (`OPENCLAW_WEBHOOK_TIMEOUT_MS`, default `5000`)
  - or CLI mode (`OPENCLAW_CMD`, default `openclaw`)
  - CLI path is guarded by timeout (`OPENCLAW_CLI_TIMEOUT_MS`, default `5000`)
- supports safe validation with `delivery.dryRun=true`

`/v1/openclaw/inbox` behavior:
- receives inbound OpenClaw messages/commands
- supported commands:
  - `/plan ...`
  - `/insights ...`
  - `/whatif ...`
- maps inbound command to StagePilot resources (`plan`, `insights`, `whatif`)
- optionally replies back through OpenClaw bridge (`reply=true`, default)
- supports `delivery.dryRun=true` for safe loop validation

Calibration template:
- `docs/stagepilot-twin-calibration-template.json`
- copy these values into the `/v1/whatif.profile` object for district realism

Sample request:

```bash
curl -s http://127.0.0.1:8080/v1/plan \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "caseId":"demo-001",
    "district":"Gangbuk-gu",
    "notes":"Rent overdue and food instability",
    "risks":["housing","food","income"],
    "urgencyHint":"high"
  }' | jq
```

What-if example:

```bash
curl -s http://127.0.0.1:8080/v1/whatif \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "caseId":"demo-whatif-001",
    "district":"Jungnang-gu",
    "notes":"Food insecurity and isolation risk",
    "risks":["food","isolation"],
    "urgencyHint":"high",
    "scenario":{
      "staffingDeltaPct":-20,
      "demandDeltaPct":25,
      "contactRateDeltaPct":5
    },
    "profile":{
      "avgHandleMinutes":36,
      "backlogCases":52,
      "caseWorkers":10,
      "demandPerHour":9.1,
      "contactSuccessRate":0.73
    }
  }' | jq
```

Notify example (safe dry-run):

```bash
curl -s http://127.0.0.1:8080/v1/notify \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "caseId":"demo-notify-001",
    "district":"Gangbuk-gu",
    "notes":"Urgent food + housing instability",
    "risks":["food","housing"],
    "urgencyHint":"high",
    "delivery":{
      "channel":"telegram",
      "target":"@welfare-ops",
      "dryRun":true
    }
  }' | jq
```

OpenClaw inbox example (safe dry-run):

```bash
curl -s http://127.0.0.1:8080/v1/openclaw/inbox \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "message":"/insights single resident with food and housing risk",
    "district":"Gangbuk-gu",
    "delivery":{
      "channel":"telegram",
      "target":"@welfare-ops",
      "dryRun":true
    }
  }' | jq
```

## Current scope
- CPU-only runtime (`USE_GPU=0`)
- Citywide + two district pilot assumptions
- Deterministic planning logic with optional Gemini narrative layer
- Optional OpenClaw operator-dispatch bridge (`OPENCLAW_*`)

## Benchmark (Tool-call + Ralph Loop)

Run:

```bash
npm run bench:stagepilot
```

What it measures:
- `baseline`: strict JSON tool-call parsing (no coercion, no retry)
- `middleware`: Hermes protocol parsing + schema coercion (`coerceBySchema`)
- `middleware+ralph-loop`: middleware parsing with bounded retry loop

Output:
- Markdown summary in console
- JSON report at `docs/benchmarks/stagepilot-latest.json`

Default benchmark options (override with env):
- `BENCHMARK_CASES` (default `24`)
- `BENCHMARK_SEED` (default `20260228`)
- `BENCHMARK_LOOP_ATTEMPTS` (default `2`)

## Deploy (Google-only, GPU-off)

Deploy to Cloud Run:

```bash
npm run deploy:stagepilot
```

The deploy script:
- loads `.env.local` when present
- enforces `USE_GPU=0`
- sets runtime env vars for StagePilot defaults
- binds Secret Manager secret as `GEMINI_API_KEY=gemini-api-key:latest`
- includes `GEMINI_HTTP_TIMEOUT_MS` in Cloud Run runtime envs
- includes `STAGEPILOT_REQUEST_BODY_TIMEOUT_MS` in Cloud Run runtime envs

Smoke test (local or Cloud Run URL):

```bash
# local
npm run smoke:stagepilot

# remote
STAGEPILOT_BASE_URL="https://<cloud-run-url>" npm run smoke:stagepilot
```

Optional smoke request timeout (per curl): `STAGEPILOT_SMOKE_CURL_MAX_TIME` (default `20`).
