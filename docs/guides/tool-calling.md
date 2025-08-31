# [dev] Tool Calling Guide

Use the middleware to enable tool calls on models without native `tools` support.

## Prebuilt middlewares

- `gemmaToolMiddleware` — JSON-mix in markdown fences (`tool_call`)
- `hermesToolMiddleware` — JSON-mix with XML wrappers (`<tool_call>`)
- `xmlToolMiddleware` — Morph-XML protocol (native XML elements per tool name)

## Generate mode

```ts
import { wrapLanguageModel, generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";

const openrouter = createOpenAICompatible({
  /* ... */
});

const { text, toolCalls } = await generateText({
  model: wrapLanguageModel({
    model: openrouter("nousresearch/hermes-3-llama-3.1-70b"),
    middleware: hermesToolMiddleware,
  }),
  prompt: "Find weather for Seoul today",
  tools: {
    get_weather: {
      description: "Get weather by city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        /* ... */
      },
    },
  },
});
```

## Streaming mode

```ts
import { wrapLanguageModel, stepCountIs, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";

const openrouter = createOpenAICompatible({
  /* ... */
});

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
```

## Tool choice

- `toolChoice: "required"` forces a call. The middleware injects a dynamic JSON schema to guide the model.
- `toolChoice: { type: "tool", toolName: "get_weather" }` forces a specific tool. The middleware injects a fixed schema for that tool.
- `toolChoice: "none"` is not supported and will throw.

## Provider options (advanced)

Pass via `providerOptions.toolCallMiddleware`:

- `onError(message, metadata)` — receive non-fatal parsing/coercion warnings.
- `originalToolSchemas` — for XML protocol to coerce arguments using provider-original schemas during generate/stream.

Example:

```ts
const result = await generateText({
  /* ... */,
  providerOptions: {
    toolCallMiddleware: {
      onError: (msg, meta) => console.warn(msg, meta),
      originalToolSchemas: {/* name->schema map */},
    },
  },
});
```

## Debugging

Set env variables:

- `DEBUG_PARSER_MW=stream` — log raw/normalized stream events
- `DEBUG_PARSER_MW=parse` — log parsed summary and original text highlighting
- `DEBUG_PARSER_MW_STYLE=bg|inverse|underline|bold` — tweak summary style

## Protocol specifics

- `gemmaToolMiddleware` (JSON-mix):
  - Emits/consumes tool calls inside markdown fences: `tool_call ...`
  - Tool responses are formatted with ```tool_response fences.
- `hermesToolMiddleware` (JSON-mix with `<tool_call>`):
  - System prompt describes `<tools>` block and requires returning JSON inside `<tool_call> ... </tool_call>` tags.
- `xmlToolMiddleware` (Morph-XML):
  - Tool call must be an XML element named after the tool (e.g., `<get_weather>...</get_weather>`).
  - Arguments are parsed by RXML (Robust XML) via `RXML.parse` and then coerced via JSON Schema. On parse/coercion issues, the protocol falls back to emitting the original text and reports via `options.onError`.

See runnable examples in `examples/parser-core/src/*`.
