<img width="3168" height="1344" alt="AI SDK Tool monorepo banner" src="https://github.com/user-attachments/assets/9a002988-e535-42ac-8baf-56ec8754410f" />

----
[![npm - parser](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm downloads - parser](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

AI SDK middleware for parsing tool calls from models that do not natively support `tools`.

## Install

```bash
pnpm add @ai-sdk-tool/parser
```

## AI SDK compatibility

Fact-checked from this repo `CHANGELOG.md` and npm release metadata (as of 2026-02-18).

| `@ai-sdk-tool/parser` major | AI SDK major | Maintenance status |
|---|---|---|
| `v1.x` | `v4.x` | Legacy (not actively maintained) |
| `v2.x` | `v5.x` | Legacy (not actively maintained) |
| `v3.x` | `v6.x` | Legacy (not actively maintained) |
| `v4.x` | `v6.x` | Active (current `latest` line) |

Note: there is no separate formal EOL announcement in releases/changelog for `v1`-`v3`; "legacy" here means non-current release lines.

## Package map

| Import | Purpose |
|---|---|
| `@ai-sdk-tool/parser` | Main middleware factory, preconfigured middleware, protocol exports |
| `@ai-sdk-tool/parser/community` | Community middleware (Sijawara, UI-TARS) |

## Quick start

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

const model = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
})("arcee-ai/trinity-large-preview:free");

const result = streamText({
  model: wrapLanguageModel({
    model,
    middleware: morphXmlToolMiddleware,
  }),
  stopWhen: stepCountIs(4),
  prompt: "What is the weather in Seoul?",
  tools: {
    get_weather: {
      description: "Get weather by city name",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, condition: "sunny", celsius: 23 }),
    },
  },
});

for await (const part of result.fullStream) {
  // text-delta / tool-input-start / tool-input-delta / tool-input-end / tool-call / tool-result
}
```

## Choose middleware

Use the preconfigured middleware exports from `src/preconfigured-middleware.ts`:

| Middleware | Best for |
|---|---|
| `hermesToolMiddleware` | JSON-style tool payloads |
| `morphXmlToolMiddleware` | XML-style payloads with schema-aware coercion |
| `yamlXmlToolMiddleware` | XML tool tags + YAML bodies |
| `qwen3CoderToolMiddleware` | Qwen/UI-TARS style `<tool_call>` markup |

## Build custom middleware

```ts
import { createToolMiddleware, qwen3CoderProtocol } from "@ai-sdk-tool/parser";

export const myToolMiddleware = createToolMiddleware({
  protocol: qwen3CoderProtocol,
  toolSystemPromptTemplate: (tools) =>
    `Use these tools and emit <tool_call> blocks only: ${JSON.stringify(tools)}`,
});
```

## Streaming semantics

- Stream parsers emit `tool-input-start`, `tool-input-delta`, and `tool-input-end` when a tool input can be incrementally reconstructed.
- `tool-input-start.id`, `tool-input-end.id`, and final `tool-call.toolCallId` are reconciled to the same ID.
- `emitRawToolCallTextOnError` defaults to `false`; malformed tool-call markup is suppressed from `text-delta` unless explicitly enabled.

Configure parser and middleware behavior through `providerOptions.toolCallMiddleware`:

```ts
const result = streamText({
  // ...
  providerOptions: {
    toolCallMiddleware: {
      onError: (message, metadata) => {
        console.warn(message, metadata);
      },
      onEvent: (event) => {
        // Typed lifecycle events:
        // transform-params.start/complete
        // generate.start/tool-choice/complete
        // stream.start/tool-choice/tool-call/finish
        console.debug(event.type, event.metadata);
      },
      emitRawToolCallTextOnError: false,
      coerce: {
        maxDepth: 64,
        onMaxDepthExceeded: (metadata) => {
          console.warn("Coercion depth cap reached", metadata);
        },
      },
    },
  },
});
```

## Local development

```bash
# Preferred
pnpm build
pnpm test
pnpm check:biome
pnpm check:types
pnpm check
```

If `pnpm` is not available in your environment yet:

```bash
corepack enable
corepack prepare pnpm@9.14.4 --activate
```

Fallback (without pnpm):

```bash
npx rimraf dist *.tsbuildinfo
npx tsup --tsconfig tsconfig.build.json
npm run check:biome
npm run typecheck
npm test
```

Run `./scripts/dev-check.sh` for the fast lint+test loop used in CI.

Google-only hackathon environment bootstrap (interactive; values only):

```bash
bash scripts/setup-google-env.sh
```

The script writes `.env.local`, enforces `USE_GPU=0`, and (if `gcloud` exists) can auto-configure project APIs and `gemini-api-key` in Secret Manager.
It also includes optional OpenClaw dispatch fields (`OPENCLAW_*`) for operator messaging.

If you want all project defaults preloaded (region/service/pilot districts/benchmark settings), run:

```bash
bash scripts/setup-hackathon-defaults.sh
```

This variant only asks for missing required values: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GCP_PROJECT_ID`.
Optional runtime guard: `GEMINI_HTTP_TIMEOUT_MS` (default `8000`).
Optional API body-read guard: `STAGEPILOT_REQUEST_BODY_TIMEOUT_MS` (default `10000`).

## StagePilot (Hackathon Skeleton)

A Google-only multi-agent orchestration skeleton is available at `src/stagepilot`.

Quick run:

```bash
npm run demo:stagepilot
```

Run API locally:

```bash
npm run api:stagepilot
```

Endpoints:
- `GET /demo` (judge-facing desktop console: intake + orchestration + what-if)
- `GET /health`
- `POST /v1/plan`
- `POST /v1/benchmark`
- `POST /v1/insights` (ontology-grounded insight summary; Gemini 3.1 Pro when key is set)
- `POST /v1/whatif` (digital-twin style scenario simulation for SLA/queue/route decisions)
- `POST /v1/notify` (OpenClaw dispatch bridge for operator channels; supports dry-run)
- `POST /v1/openclaw/inbox` (OpenClaw inbound command router: `/plan`, `/insights`, `/whatif`)

After `npm run api:stagepilot`, open `http://127.0.0.1:8080/demo` for the laptop judging UI.

Benchmark run (CPU-only, compares baseline vs middleware vs ralph-loop retry):

```bash
npm run bench:stagepilot
```

This writes benchmark output to `docs/benchmarks/stagepilot-latest.json`.

Cloud Run deploy (Google-only):

```bash
npm run deploy:stagepilot
```

This deploy script enforces `USE_GPU=0` and mounts `GEMINI_API_KEY` from Secret Manager (`gemini-api-key`).
OpenClaw remains optional and can be enabled via runtime env (`OPENCLAW_ENABLED=1`) with either webhook or CLI mode.
For Gemini request safety, set `GEMINI_HTTP_TIMEOUT_MS` (default `8000`).
For request body upload safety (full upload budget), set `STAGEPILOT_REQUEST_BODY_TIMEOUT_MS` (default `10000`).
For webhook safety, set `OPENCLAW_WEBHOOK_TIMEOUT_MS` (default `5000`).
For CLI mode safety, set `OPENCLAW_CLI_TIMEOUT_MS` (default `5000`).

Post-deploy smoke test:

```bash
STAGEPILOT_BASE_URL="https://<your-cloud-run-url>" npm run smoke:stagepilot
```

Optional smoke request timeout: `STAGEPILOT_SMOKE_CURL_MAX_TIME` (default `20` seconds per request).

Details: `docs/STAGEPILOT.md`.

## Examples in this repo

- Parser middleware examples: `examples/parser-core/README.md`
- RXML examples: `examples/rxml-core/README.md`
- Hello middleware preset: `src/examples/hello-tool-middleware.ts` with a matching `tests/hello-middleware.test.ts` sanity check.

Run one example from repo root:

```bash
pnpm dlx tsx examples/parser-core/src/01-stream-tool-call.ts
```
