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

## Package map

| Import | Purpose |
|---|---|
| `@ai-sdk-tool/parser` | Main middleware factory, preconfigured middleware, protocol exports |
| `@ai-sdk-tool/parser/community` | Community middleware (Sijawara, UI-TARS) |

## Quick start

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { qwen3CoderToolMiddleware } from "@ai-sdk-tool/parser";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

const model = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
})("stepfun/step-3.5-flash:free");

const result = streamText({
  model: wrapLanguageModel({
    model,
    middleware: qwen3CoderToolMiddleware,
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

Configure parser error behavior through `providerOptions.toolCallMiddleware`:

```ts
const result = streamText({
  // ...
  providerOptions: {
    toolCallMiddleware: {
      onError: (message, metadata) => {
        console.warn(message, metadata);
      },
      emitRawToolCallTextOnError: false,
    },
  },
});
```

## Local development

```bash
pnpm build
pnpm test
pnpm check:biome
pnpm check:types
pnpm check
```

## Examples in this repo

- Parser middleware examples: `examples/parser-core/README.md`
- RXML examples: `examples/rxml-core/README.md`

Run one example from repo root:

```bash
pnpm dlx tsx examples/parser-core/src/01-stream-tool-call.ts
```
