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
- `jsonProtocol`, `xmlProtocol`, `yamlProtocol`, and `qwen3coder_tool_parser`: malformed streaming tool payloads do not emit raw protocol markup to `text-delta` by default. Set `emitRawToolCallTextOnError: true` in parser options only if you explicitly want raw fallback text.
- `tool-input-start.id`, `tool-input-end.id`, and `tool-call.toolCallId` are reconciled to the same ID for each tool call stream.

## Qwen3CoderToolParser (protocol + middleware)

Use Qwen3CoderToolParser when your model/prompt expects this XML-like tool markup, or when you want a human-readable tool-call format with repeated `<parameter=...>` tags for arrays. If you can control the tool format freely, prefer:

- `jsonProtocol` for strict, nested JSON arguments
- `xmlProtocol` / `yamlProtocol` for schema-driven nested structures
- `qwen3coder_tool_parser` for this format (`<tool_call><function=...><parameter=...>`)

### Exact tool-call format

`qwen3coder_tool_parser` expects (and `formatToolCall()` emits) tool calls like:

```xml
<tool_call>
  <function=TOOL_NAME>
    <parameter=PARAM_NAME>VALUE</parameter>
    <parameter=PARAM_NAME>VALUE</parameter> <!-- repeat for arrays -->
  </function>
</tool_call>
```

Notes:

- Parsed tool inputs are JSON objects where all values are strings.
- Repeating the same parameter name produces an array (order preserved).
- Whitespace around values is trimmed and XML entities are unescaped.

### Usage (preconfigured)

Qwen3CoderToolParser middleware is exported via the `./community` entrypoint (`qwen3CoderToolParserMiddleware`):

```ts
import { wrapLanguageModel, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { qwen3CoderToolParserMiddleware } from "@ai-sdk-tool/parser/community";

const client = createOpenAICompatible({
  /* baseURL, apiKey */
});

const result = streamText({
  model: wrapLanguageModel({
    model: client("your-model-name"),
    middleware: qwen3CoderToolParserMiddleware,
  }),
  tools: {
    /* your tools */
  },
  prompt: "Find weather for Seoul today",
  providerOptions: {
    toolCallMiddleware: {
      onError: (message, metadata) => {
        console.warn(message, metadata);
      },
      // Defaults to false: avoids leaking raw <tool_call> markup into user text.
      emitRawToolCallTextOnError: false,
    },
  },
});

for await (const part of result.fullStream) {
  // handle text and tool events
}
```

### Usage (custom prompt)

If you want to bring your own system prompt, build middleware directly from the protocol:

```ts
import { createToolMiddleware, qwen3coder_tool_parser } from "@ai-sdk-tool/parser";

export const myQwen3CoderToolParserMiddleware = createToolMiddleware({
  protocol: qwen3coder_tool_parser,
  toolSystemPromptTemplate: (tools) => {
    // Return a system prompt that instructs the model to emit <tool_call> markup.
    return `Tools: ${JSON.stringify(tools)}`;
  },
});
```

### Limitations

- Qwen3CoderToolParser parameter values are parsed as strings. If your tools require nested objects, prefer `jsonProtocol` or `xmlProtocol`.
- In streaming mode, incomplete/malformed `<tool_call>` blocks are suppressed by default (to avoid showing raw markup to end users). Enable `emitRawToolCallTextOnError` only if you explicitly want raw fallback text.
