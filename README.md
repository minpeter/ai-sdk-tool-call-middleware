<img width="3168" height="1344" alt="AI SDK Tool monorepo banner" src="https://github.com/user-attachments/assets/9a002988-e535-42ac-8baf-56ec8754410f" />

----
[![npm - parser](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm downloads - parser](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

AI SDK middleware for parsing tool calls from models that do not natively support `tools`.

This package is ESM-only. Use `import` or dynamic `import()`; CommonJS
`require()` is not supported.

## Install

```bash
# Current stable line (v6.x) — built for AI SDK v7
pnpm add @ai-sdk-tool/parser
```

If you still need the AI SDK v6 line, pin `v4`:

```bash
pnpm add @ai-sdk-tool/parser@4
```

## AI SDK compatibility

Fact-checked from this repo `CHANGELOG.md` and npm release metadata.

| `@ai-sdk-tool/parser` major | AI SDK major | Maintenance status |
|---|---|---|
| `v1.x` | `v4.x` | Legacy (not actively maintained) |
| `v2.x` | `v5.x` | Legacy (not actively maintained) |
| `v3.x` | `v6.x` | Legacy (not actively maintained) |
| `v4.x` | `v6.x` | Previous AI SDK v6 line |
| `v5.x` | `v7.x` | Previous AI SDK v7 line |
| `v6.x` | `v7.x` | Active (current `latest` line) |

Note: there is no separate formal EOL announcement in releases/changelog for `v1`-`v3`; "legacy" here means non-current release lines.

## Upgrading from v5 to v6

`v6.0.0` keeps AI SDK v7 (`specificationVersion: "v4"`) compatibility while refactoring middleware configuration into orthogonal `promptStrategy` and `historyStrategy` unions and isolating internal transport state.

| v5 option / export | v6 replacement |
|---|---|
| `toolSystemPromptTemplate` | `promptStrategy: { mode: "text", template }` |
| `placement` | `promptStrategy: { mode: "text", template, placement }` |
| `suppressToolSystemPromptForForcedChoice` | `promptStrategy: { ..., suppressForForcedChoice }` |
| `transformKExaone236BParams` | `promptStrategy: { mode: "messages", build }` (or `kExaone236BToolMiddleware`) |
| `historyMode: "converted-text"` + `toolResponsePromptTemplate` | `historyStrategy: { mode: "converted-text", toolResponsePromptTemplate }` |
| `historyMode: "provider-native"` | `historyStrategy: { mode: "provider-native" }` |
| `allowsGeneratedTextJsonRecovery` on custom protocols | `allowsFallbackRecovery` on `TCMProtocol` |
| Legacy aliases (`TCMCoreProtocol`, `isTCMProtocolFactory`, `Qwen3CoderToolParser`, `uiTarsXmlProtocol`, `KExaone2ToolParser`, `KExaone236BToolParser`) | `TCMProtocol`, `isProtocolFactory`, `qwen3CoderProtocol`, `kExaone2Protocol`, `kExaone236BProtocol` |

- **Unified `transformParams` default placement:** direct calls to `transformParams` now default `placement` to `DEFAULT_TOOL_SYSTEM_PROMPT_PLACEMENT` (`"last"`), matching `createToolMiddleware` (previously `"first"`). Pass `placement: "first"` explicitly if you relied on the old default.
- **Transport isolation:** middleware-managed transport metadata lives under internal `_internal` state populated by `transformParams` and is stripped before calling the underlying provider model or protocol parser.
- **`messages` prompt mode example:**

```ts
import {
  createToolMiddleware,
  kExaone236BProtocol,
  kExaone236BSystemPromptMessages,
} from "@ai-sdk-tool/parser";

const middleware = createToolMiddleware({
  protocol: kExaone236BProtocol,
  promptStrategy: {
    mode: "messages",
    build: kExaone236BSystemPromptMessages,
    suppressForForcedChoice: true,
  },
  historyStrategy: { mode: "provider-native" },
});
```

## Upgrading from v4 (AI SDK v6) to AI SDK v7

The `v5.x` / `v6.x` lines target **AI SDK v7** (provider specification v4). The `v4.x` line remains available for AI SDK v6.

```bash
pnpm add @ai-sdk-tool/parser
```

**Breaking changes vs. the `v4.x` line:**

- **Requires `ai@^7` / `@ai-sdk/provider@^4`.** This line is **not** compatible with the AI SDK v6 line. The middleware declares `specificationVersion: "v4"` and uses the `LanguageModelV4*` provider types.
- **`@ai-sdk/provider` and `@ai-sdk/provider-utils` are now peer dependencies.** They are normally satisfied transitively by `ai@7`, so most apps need no extra install. If your package manager does not auto-install peers, add them explicitly:
  ```bash
  pnpm add @ai-sdk/provider@^4 @ai-sdk/provider-utils@^5
  ```
- **Node.js `>=22` is required** (Node 18 is end-of-life).
- Tool-result file parts now use the v4 tagged file shape (`{ type: "data", data }`) instead of a bare `data` string. This only affects code that constructs tool-result file parts directly.

### Tool-result media (images / files)

When a tool returns multimodal `output: { type: "content", value: [...] }`, the middleware projects that into the next model turn:

| `mediaStrategy.mode` | Behavior |
|---|---|
| `model` (**default**) | Forward canonical `{ type: "file", data }` content as model file parts. Protocol wrappers stay as adjacent `text`. |
| `placeholder` | Text-only fallback (`[Image: image/png]`, `[File URL: ...]`, …) for non-vision models. |
| `auto` | Keep original tool content parts when `capabilities` enable that media kind; otherwise placeholder. |

```ts
import {
  createHermesToolResponseFormatter,
  createToolMiddleware,
  hermesProtocol,
  hermesSystemPromptTemplate,
} from "@ai-sdk-tool/parser";

// Default preconfigured middleware already uses model media mode.
// For text-only models, opt into placeholders:
const textOnlyMiddleware = createToolMiddleware({
  protocol: hermesProtocol(),
  promptStrategy: {
    mode: "text",
    template: hermesSystemPromptTemplate,
  },
  historyStrategy: {
    mode: "converted-text",
    toolResponsePromptTemplate: createHermesToolResponseFormatter({
      mediaStrategy: { mode: "placeholder" },
    }),
  },
});

// YAML XML tool *responses* reuse Morph's response formatter — use the Morph
// factory when you need mediaStrategy options with yamlXmlProtocol.
```

Only `http:` / `https:` file URLs are forwarded as model file parts; other schemes become placeholders. String URLs from JSON-deserialized tool results are reparsed to `URL` objects intentionally.

User-message images are unchanged — they pass through as-is.

**Status:** `v6.x` is the current stable release line for AI SDK v7. Pin an exact version if you need reproducible installs.

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
| `glm5ToolMiddleware` | GLM-5/5.2 official `<arg_key>/<arg_value>` text grammar, including true incremental streaming |
| `hermesToolMiddleware` | JSON-style tool payloads |
| `morphXmlToolMiddleware` | XML-style payloads with schema-aware coercion |
| `yamlXmlToolMiddleware` | XML tool tags + YAML bodies |
| `qwen3CoderToolMiddleware` | Qwen/UI-TARS style `<tool_call>` markup |
| `kExaone2ToolMiddleware` | K-EXAONE-2.0 native tool declarations, calls, and `<tool_result>` responses |
| `kExaone236BToolMiddleware` | Friendli K-EXAONE-236B native `tool_declare`, Hermes JSON calls, reasoning, and structured history |

### LG EXAONE API and Pi (K-EXAONE 2.5)

Pi's `exaone/k-exaone_v2.5` entry connects to LG AI Research's hosted
K-EXAONE 2.5 model. The [EXAONE API](https://docs.exaone.ai/en/docs/k-exaone-2.5)
returns structured tool calls and reasoning. In AI SDK, pass the OpenAI-compatible
chat model directly to `generateText` or `streamText` to preserve those responses.
Use `kExaone2ToolMiddleware` for K-EXAONE **2.0** deployments that emit text tool calls.

With `EXAONE_API_KEY` set, this example streams a tool call, executes it locally,
and sends the result back for a final answer:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const exaone = createOpenAICompatible({
  name: "exaone",
  baseURL: "https://api.exaone.ai/v1",
  apiKey: process.env.EXAONE_API_KEY,
});

const result = streamText({
  model: exaone.chatModel("k-exaone_v2.5"),
  prompt: "Call lookup_code once with city Seoul, then report the returned code.",
  providerOptions: { exaone: { reasoning_effort: "low" } },
  maxOutputTokens: 1024,
  stopWhen: stepCountIs(2),
  tools: {
    lookup_code: tool({
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ code: city === "Seoul" ? "SEL" : null }),
    }),
  },
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

The 15-case comparison against the other presets is in
[docs/k-exaone-2.5-middleware-comparison.md](docs/k-exaone-2.5-middleware-comparison.md).

### Friendli K-EXAONE-236B

`kExaone236BToolMiddleware` is a Friendli-specific compatibility preset. It
injects the model's native tool declaration as the first `tool_declare`
message, follows it with a separate system message that demonstrates the
Hermes JSON-in-`<tool_call>` format, and preserves assistant reasoning/tool
calls and tool-result history.

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { kExaone236BToolMiddleware } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_API_KEY,
  baseURL: "https://api.friendli.ai/serverless/v1",
  transformRequestBody: (body) => ({
    ...body,
    parse_reasoning: true,
    chat_template_kwargs: { enable_thinking: false },
  }),
});

const model = wrapLanguageModel({
  model: friendli.chatModel("LGAI-EXAONE/K-EXAONE-236B-A23B"),
  middleware: kExaone236BToolMiddleware,
});
```

This preset relies on two version-sensitive behaviors: the AI SDK
OpenAI-compatible message-role override and Friendli accepting the undocumented
`tool_declare` role. Friendli reported a Serverless deprecation date of
2026-08-20 for this model; validate availability and `/chat/render` structure
when pinning a new provider or model version.

### GLM-5.2

`glm5ToolMiddleware` follows the official `zai-org/GLM-5.2`
`chat_template.jinja` grammar pinned at revision
`b4734de4facf877f85769a911abafc5283eab3d9`. It preserves provider-native
assistant/tool history and inserts the tool catalog as a distinct leading
system turn for automatic tool selection, matching the template's training-time
layout. For `required` or fixed-tool selection it omits that XML catalog so it
does not conflict with the middleware's JSON `responseFormat` constraint.

This remains prompt-only middleware. AI SDK function definitions are rendered
into that system turn and the transformed provider request always contains
`tools: []` and no `toolChoice`. The provider returns ordinary generated text;
the middleware parses GLM's `<tool_call>` text back into AI SDK tool-call parts.
There is no provider-native or hybrid GLM transport in this package.

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { glm5ToolMiddleware } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

const provider = createOpenAICompatible({
  name: "glm",
  apiKey: process.env.GLM_API_KEY,
  baseURL: process.env.GLM_BASE_URL,
  // Required for schema-constrained `required` or fixed-tool selection.
  // Omit this if the endpoint does not support `response_format.json_schema`.
  supportsStructuredOutputs: true,
});

const model = wrapLanguageModel({
  model: provider("zai-org/glm-5.2"),
  middleware: glm5ToolMiddleware,
});
```

The parser handles zero-argument and parallel calls, schema-aware scalar and
JSON values, arbitrary stream chunk boundaries, and conservative recovery of
truncated closing tags. Non-string values are buffered until they can be
validated; long string values can emit `tool-input-delta` events before the
closing tag arrives. For object leaves that explicitly allow arbitrary
properties, it also preserves bounded bare handles such as `responseData` as
strings instead of evaluating or completing an expression. Set
`recoverOpaqueObjectReferences: false` on `glm5Protocol()` when strict JSON-only
object values are required.

Ambiguous or unsafe structure fails closed: duplicate and prototype-sensitive
keys, as well as a complete nested call naming a declared tool, reject the
whole call. A canonical marker placed directly inside a Markdown backtick
delimiter is kept as non-executable text. The delimiter tracker is
chunk-invariant and deliberately does not let an unrelated, unbalanced prose
backtick swallow a later canonical call.

## Build custom middleware

```ts
import { createToolMiddleware, qwen3CoderProtocol } from "@ai-sdk-tool/parser";

export const myToolMiddleware = createToolMiddleware({
  protocol: qwen3CoderProtocol,
  promptStrategy: {
    mode: "text",
    template: (tools) =>
      `Use these tools and emit <tool_call> blocks only: ${JSON.stringify(tools)}`,
  },
});
```

## Tool choice

- `toolChoice: "auto"` (default) parses tool calls out of the model text.
- `toolChoice: "required"` and `toolChoice: { type: "tool", toolName }` are emulated through JSON `responseFormat` constraints.
- `toolChoice: "none"` skips tool prompt injection and tool-call parsing entirely; tool-call history retains the middleware's configured `historyStrategy` representation.
- Presets configured with `historyStrategy: { mode: "provider-native" }` (`kExaone236BToolMiddleware` and `glm5ToolMiddleware`) preserve provider-native structured assistant/tool history under `toolChoice: "none"` and only skip tool-catalog injection.
- Prompt-based middleware omits provider-defined tools and reports each omission
  as an unsupported warning in generate and stream results. Explicitly choosing
  a provider-defined tool by name is rejected because it has no function-tool
  schema; use custom function tools instead.

Forced selection requires a provider that honors schema-bearing JSON response
formats. With `createOpenAICompatible`, enable `supportsStructuredOutputs` only
when the target endpoint supports `response_format.json_schema`.

## Streaming semantics

- Stream parsers emit `tool-input-start`, `tool-input-delta`, and `tool-input-end` when a tool input can be incrementally reconstructed.
- `kExaone2ToolMiddleware` leaves reasoning parsing to the provider so generate and stream behave consistently. With Friendli, set `parse_reasoning: true`; provider reasoning events pass through unchanged.
- `kExaone236BToolMiddleware` also leaves reasoning provider-native and preserves structured assistant/tool history instead of converting it to prompt text.
- `tool-input-start.id`, `tool-input-end.id`, and final `tool-call.toolCallId` are reconciled to the same ID.
- `raw` chunks (`includeRawChunks`) and `ping` heartbeats pass through in order without interrupting a tool call that is still being received.
- Text `citations` are carried over after tool-call parsing. Offsets are re-anchored only when the surviving range is unambiguous; otherwise the source and cited passage are kept without offsets. If no text remains, or the stream already closed the cited block, citations are attached to an empty text block.
- Text `providerMetadata` is retained when the entire provider block survives unchanged; it is omitted from split, merged, or detached text blocks.
- An `interrupted` finish reason is preserved even when tool calls were parsed, so the AI SDK does not execute a tool call from an incomplete response.
- `emitRawToolCallTextOnError` defaults to `false`; malformed tool-call markup is suppressed from `text-delta` unless explicitly enabled.
- Text blocks that consist of a bare `{"name": ..., "arguments": ...}` payload (or a fenced ```json block) for a known tool are recovered into tool calls in both generate and stream paths. When tool calls are parsed, `stop`/`other` finish reasons become `tool-calls`; terminal reasons such as `length`, `content-filter`, `error`, and `interrupted` are preserved.

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
