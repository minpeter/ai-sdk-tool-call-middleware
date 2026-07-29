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
# Current stable line (v5.x) — built for AI SDK v7
pnpm add @ai-sdk-tool/parser
```

If you still need the AI SDK v6 line, pin the previous major:

```bash
pnpm add @ai-sdk-tool/parser@4
```

## AI SDK compatibility

Fact-checked from this repo `CHANGELOG.md` and npm release metadata (as of 2026-06-25).

| `@ai-sdk-tool/parser` major | AI SDK major | Maintenance status |
|---|---|---|
| `v1.x` | `v4.x` | Legacy (not actively maintained) |
| `v2.x` | `v5.x` | Legacy (not actively maintained) |
| `v3.x` | `v6.x` | Legacy (not actively maintained) |
| `v4.x` | `v6.x` | Previous stable line |
| `v5.x` | `v7.x` | Active (current `latest` line) |

Note: there is no separate formal EOL announcement in releases/changelog for `v1`-`v3`; "legacy" here means non-current release lines.

## Upgrading to v7

The `5.0.0` line targets **AI SDK v7** (provider specification v4). It is the current `latest` line; the `v4.x` line remains available for AI SDK v6.

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
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
  toolResponsePromptTemplate: createHermesToolResponseFormatter({
    mediaStrategy: { mode: "placeholder" },
  }),
});

// YAML XML tool *responses* reuse Morph's response formatter — use the Morph
// factory when you need mediaStrategy options with yamlXmlProtocol.
```

Only `http:` / `https:` file URLs are forwarded as model file parts; other schemes become placeholders. String URLs from JSON-deserialized tool results are reparsed to `URL` objects intentionally.

User-message images are unchanged — they pass through as-is.

**Status:** `5.0.0` is the stable release line. Pin an exact version if you need reproducible installs.

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
  toolSystemPromptTemplate: (tools) =>
    `Use these tools and emit <tool_call> blocks only: ${JSON.stringify(tools)}`,
});
```

## Tool choice

- `toolChoice: "auto"` (default) parses tool calls out of the model text.
- `toolChoice: "required"` and `toolChoice: { type: "tool", toolName }` are emulated through JSON `responseFormat` constraints.
- `toolChoice: "none"` skips tool prompt injection and tool-call parsing entirely; tool-call history retains the middleware's configured representation.

Forced selection requires a provider that honors schema-bearing JSON response
formats. With `createOpenAICompatible`, enable `supportsStructuredOutputs` only
when the target endpoint supports `response_format.json_schema`.

## Streaming semantics

- Stream parsers emit `tool-input-start`, `tool-input-delta`, and `tool-input-end` when a tool input can be incrementally reconstructed.
- `tool-input-start.id`, `tool-input-end.id`, and final `tool-call.toolCallId` are reconciled to the same ID.
- `emitRawToolCallTextOnError` defaults to `false`; malformed tool-call markup is suppressed from `text-delta` unless explicitly enabled.
- Text blocks that consist of a bare `{"name": ..., "arguments": ...}` payload (or a fenced ```json block) for a known tool are recovered into tool calls in both generate and stream paths, and `finishReason` is normalized to `tool-calls` whenever tool calls were parsed.

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
