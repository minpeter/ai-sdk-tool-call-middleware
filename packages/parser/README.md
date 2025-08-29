# AI SDK - tool call parser middleware

▲ Also available in the Vercel AI SDK official documentation: [Custom tool call parser](https://ai-sdk.dev/docs/ai-sdk-core/middleware#custom-tool-call-parser)

[![npm](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

> [!NOTE]
> Depends on AI SDK v5. For AI SDK v4, pin `@ai-sdk-tool/parser@1.0.0`.

Middleware that enables tool calling with models that don’t natively support OpenAI‑style `tools`. Works with any provider (OpenRouter, vLLM, Ollama, etc.) via AI SDK v2 middleware.

## Why This Exists

Many self‑hosted or third‑party model endpoints (vLLM, MLC‑LLM, Ollama, OpenRouter, etc.) don’t yet expose the OpenAI‑style `tools` parameter, forcing you to hack together tool parsing.  
This project provides a flexible middleware that:

- Parses tool calls from streaming or batch responses
- Supports Hermes and Gemma formats
- Llama, Mistral, and JSON formats are coming soon
- Gain complete control over the tool call system prompt.

## Installation

```bash
pnpm add @ai-sdk-tool/parser
```

## Quickstart (streaming)

```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, stepCountIs, streamText } from "ai";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";

const openrouter = createOpenAICompatible({
  /* ... */
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: openrouter("google/gemma-3-27b-it"),
      middleware: gemmaToolMiddleware,
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in my city?",
    stopWhen: stepCountIs(4),
    tools: {
      get_location: {
        /* ... */
      },
      get_weather: {
        /* ... */
      },
    },
  });

  for await (const part of result.fullStream) {
    // handle text/tool events
  }
}

main().catch(console.error);
```

## Quickstart (generate)

```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, generateText } from "ai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";

const openrouter = createOpenAICompatible({
  /* ... */
});

async function main() {
  const { text } = await generateText({
    model: wrapLanguageModel({
      model: openrouter("nousresearch/hermes-3-llama-3.1-70b"),
      middleware: hermesToolMiddleware,
    }),
    prompt: "Find weather for Seoul today",
    tools: {
      get_weather: {
        /* ... */
      },
    },
  });

  console.log(text);
}

main().catch(console.error);
```

## Prebuilt middlewares

- `gemmaToolMiddleware` — JSON‑mix format inside markdown fences (`tool_call/`tool_response).
- `hermesToolMiddleware` — JSON‑mix format with XML wrappers (`<tool_call>` tags).
- `xmlToolMiddleware` — XML format (Morph‑XML protocol).

## Protocols

- `jsonMixProtocol` — JSON function calls in flexible text wrappers.
- `morphXmlProtocol` — XML element per call, robust to streaming.

## Examples

See `examples/parser-core/src/*` for runnable demos (streaming/non‑streaming, tool choice).
