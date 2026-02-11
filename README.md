<img width="3168" height="1344" alt="AI SDK Tool monorepo banner" src="https://github.com/user-attachments/assets/9a002988-e535-42ac-8baf-56ec8754410f" />

----
[![npm - parser](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm downloads - parser](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

Tooling for Vercel AI SDK: enable tool calling with models lacking native `tools`.

- **@ai-sdk-tool/parser**: add tool-calling via middleware; works with any provider supported by AI SDK `wrapLanguageModel`.
- **@ai-sdk-tool/parser/rxml**: robust XML parser/streamer/builder for AI-generated XML.
- **@ai-sdk-tool/parser/rjson**: relaxed JSON parser with tolerant mode and JSON5-like syntax support.

## Usage at a glance

```ts
import { wrapLanguageModel, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { xmlToolMiddleware } from "@ai-sdk-tool/parser";

const client = createOpenAICompatible({
  /* baseURL, apiKey */
});

const result = streamText({
  model: wrapLanguageModel({
    model: client("your-model-name"),
    middleware: xmlToolMiddleware,
  }),
  tools: {
    /* your tools */
  },
  prompt: "Find weather for Seoul today",
});

for await (const part of result.fullStream) {
  // handle text and tool events
}
```

## Tool-input delta semantics

- `jsonProtocol`: `tool-input-delta` emits incremental JSON argument text.
- `xmlProtocol` and `yamlProtocol`: `tool-input-delta` now also emits incremental JSON argument text (parsed-object prefixes), not raw XML/YAML fragments.
- `xmlProtocol` and `yamlProtocol`: malformed streaming tool payloads do not emit raw protocol markup to `text-delta` by default. Set `emitRawToolCallTextOnError: true` in parser options only if you explicitly want raw fallback text.
- `tool-input-start.id`, `tool-input-end.id`, and `tool-call.toolCallId` are reconciled to the same ID for each tool call stream.
