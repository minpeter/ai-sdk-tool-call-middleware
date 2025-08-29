# [dev] Protocols

A `ToolCallProtocol` defines the wire format for tool calling: how tools are shown to the model, how the model should return a tool call, and how output is parsed back into AI SDK content/stream parts.

- Format tools: `formatTools` — how to present tool signatures to the model
- Format tool call: `formatToolCall` — how a single invocation is rendered
- Format tool response: `formatToolResponse` — how tool results are echoed back
- Parse generation: `parseGeneratedText` — parse non-streamed output
- Stream parser: `createStreamParser` — parse streamed output incrementally
- Debug helper (optional): `extractToolCallSegments` — return substrings that would be parsed as tool calls

See the interface in `packages/parser/src/protocols/tool-call-protocol.ts`.

## Built-in Protocols

- `jsonMixProtocol` — JSON payloads wrapped in simple tags; can be retargeted to markdown code fences.
  - Default delimiters: `<tool_call>...</tool_call>` for calls and `<tool_response>...</tool_response>` for results.
  - `formatTools` serializes tools to JSON and injects them via your `toolSystemPromptTemplate`.
  - `parseGeneratedText` and `createStreamParser` detect the wrapped JSON and emit `{ type: "tool-call", toolName, input }` parts. Non-tool text is passed through as `{ type: "text" }`.
  - You can customize delimiters (e.g., triple-fenced blocks) when creating the middleware. Example: the prebuilt Gemma middleware uses markdown fences labeled `tool_call`.

- `morphXmlProtocol` — one XML element per call with the tag equal to the tool name (e.g., `<get_weather>...</get_weather>`).
  - Strong streaming support: the stream parser buffers text, recognizes start/end tags, and emits a `tool-call` when a full element arrives.
  - Argument parsing: XML content is converted to an object with heuristics for text nodes, repeated tags (arrays), `item` lists, and tuple-like indexed objects.
  - Type coercion: values are coerced using the tool's JSON schema via `coerceBySchema` (original provider schemas are used when available).
  - `formatTools` emits tool signatures as JSON (using `unwrapJsonSchema`) inside your system prompt template. `formatToolResponse` returns a `<tool_response>` XML block.

Implementations live in `packages/parser/src/protocols/`.

## Choosing a Protocol

- Prefer `jsonMixProtocol` when the model tends to output JSON reliably or when you can guide it with fences (e.g., Gemma/Hermes-style prompts).
- Prefer `morphXmlProtocol` when you need robust streaming detection and schema-aware argument coercion, or when XML-style tags work better for the model.

## Using Protocols via Middleware

Protocols are wired through the middleware created by `createToolMiddleware` (see `packages/parser/src/tool-call-middleware.ts`). The middleware:

- Injects tool signatures into the system prompt using `protocol.formatTools` in `transformParams`.
- Parses non-stream outputs with `protocol.parseGeneratedText` in `wrapGenerate`.
- Parses stream deltas with `protocol.createStreamParser` in `wrapStream`.

Preconfigured middlewares exported from `packages/parser/src/index.ts`:

- `gemmaToolMiddleware` — Uses `jsonMixProtocol` with markdown code fences labeled `tool_call` and a prompt tailored for Gemma.
- `hermesToolMiddleware` — `jsonMixProtocol` with `<tool_call>` tags and a Hermes-style prompt.
- `xmlToolMiddleware` — `morphXmlProtocol` with an XML-oriented prompt.

## Implementing a Custom Protocol

Provide an object that satisfies `ToolCallProtocol`:

- Implement the five required methods: `formatTools`, `formatToolCall`, `formatToolResponse`, `parseGeneratedText`, `createStreamParser`.
- Ensure `parseGeneratedText` emits `text` parts for non-tool content and `tool-call` parts for recognized calls; call `options.onError` and pass through original text on parse failures.
- Ensure `createStreamParser` emits `text-start` / `text-delta` / `text-end` events around regular text and `tool-call` events when a full call is recognized; treat partial/incomplete segments conservatively and report non-fatal errors via `options.onError`.
- Optionally implement `extractToolCallSegments` to return the exact substrings that would be interpreted as tool calls (useful for debugging/telemetry).

Tip: Keep the call/result formats symmetric so `formatToolResponse` mirrors the call format the model sees. This makes multi-turn tool usage more reliable.
