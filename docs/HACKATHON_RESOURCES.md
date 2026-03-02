# Hackathon Resource Defaults

This project is configured as Google-only and GPU-off by default.

## Fixed Defaults
- `HACKATHON_TRACK`: `social-good`
- `GCP_REGION`: `asia-northeast3`
- `FIRESTORE_DATABASE`: `(default)`
- `SERVICE_NAME_API`: `stagepilot-api`
- `ARTIFACT_REPO`: `stagepilot`
- `USE_GPU`: `0`
- `PILOT_DISTRICT_1`: `강북구`
- `PILOT_DISTRICT_2`: `중랑구`
- `BENCHMARK_CASES`: `24`
- `SLA_URGENT_MINUTES`: `120`
- `SLA_NORMAL_HOURS`: `24`

## Required User Inputs
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (exact model ID shown in AI Studio/Vertex)
- `GCP_PROJECT_ID`
- `GEMINI_HTTP_TIMEOUT_MS` is optional (default `8000`)
- `STAGEPILOT_REQUEST_BODY_TIMEOUT_MS` is optional (default `10000`)

## Optional Operator Dispatch Inputs (OpenClaw)
- `OPENCLAW_ENABLED` (`0` or `1`)
- `OPENCLAW_WEBHOOK_URL` (preferred in Cloud Run)
- `OPENCLAW_WEBHOOK_TIMEOUT_MS` (webhook request timeout guard, default `5000`)
- `OPENCLAW_CHANNEL` / `OPENCLAW_TARGET` / `OPENCLAW_THREAD_ID`
- `OPENCLAW_API_KEY` (if webhook requires bearer auth)
- `OPENCLAW_CMD` (CLI fallback, default `openclaw`)
- `OPENCLAW_CLI_TIMEOUT_MS` (CLI command timeout guard, default `5000`)

## One Command
```bash
bash scripts/setup-hackathon-defaults.sh
```

The command writes `.env.local`, enforces `USE_GPU=0`, and if `gcloud` is installed it can auto-run:
- project selection
- required API enablement
- Secret Manager upsert: `gemini-api-key`

## Deploy Command

```bash
npm run deploy:stagepilot
```

This deploys the StagePilot API to Cloud Run and mounts `GEMINI_API_KEY` from Secret Manager.
