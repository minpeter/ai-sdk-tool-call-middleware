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
  - Argument parsing: XML arguments are parsed by RXML (Robust XML) via `RXML.parse`, which encapsulates XML parsing and heuristics (text nodes, repeated tags → arrays, `item` lists, tuple-like indexed objects, numeric conversion, raw string extraction for string-typed fields). RXML throws typed errors (`RXMLParseError`, `RXMLDuplicateStringTagError`, `RXMLCoercionError`) and the protocol catches these to apply fallback behavior.
  - Type coercion: values are coerced using the tool's JSON schema via `coerceBySchema` (original provider schemas are used when available).
  - `formatTools` emits tool signatures as JSON (using `unwrapJsonSchema`) inside your system prompt template. `formatToolResponse` returns a `<tool_response>` XML block.

### morph-xml: Duplicate string tag handling

Some models may mistakenly emit multiple tags for a property whose schema type is `string`, e.g. `<content>part1</content><content>part2</content>`. This is considered malformed output. The `morphXmlProtocol` handles this strictly:

- If duplicate tags are detected for a `string` field, the entire tool call is cancelled and emitted as text. A warning is reported via `options.onError` when provided.

This behavior is consistent in both non-stream (`parseGeneratedText`) and stream (`createStreamParser`) paths; no tool-call part is emitted in this case. Internally, this is surfaced as `RXMLDuplicateStringTagError` from RXML and handled by the protocol with a pass-through of the original text and an `onError` message.

### RXML (Robust XML) utility

RXML is a reusable XML parsing utility independent from the protocol layer.

- Simple API: `RXML.parse(xmlInner, jsonSchema, options?)` returns a schema-coerced object or throws a typed error.
- Stringify: `RXML.stringify(rootTag, obj, { format?, suppressEmptyNode? })` builds XML for display/echoing results.
- Options: `textNodeName` (default `#text`), `throwOnDuplicateStringTags` (default `true`).
- Error types: `RXMLParseError` (XML parse failure), `RXMLDuplicateStringTagError` (duplicate string tags), `RXMLCoercionError` (schema coercion failure).

RJSON (Robust JSON) is the counterpart for JSON: `RJSON.parse` accepts relaxed JSON often produced by LLMs (unquoted keys, comments, trailing commas) and aims to be resilient to minor noise while preserving correctness.

### Robust parsing

In this project, “Robust” means resilient to minor LLM imperfections and noise. Robust parsers (RJSON/RXML) attempt best-effort recovery and normalization for slightly malformed or unconventional outputs while maintaining a clear error model:

- Non-fatal issues are normalized when safe (e.g., relaxed JSON features, common XML list patterns).
- Fatal issues are surfaced as typed errors from the robust utility (e.g., `RXMLParseError`), and callers (protocols) decide fallback behavior (usually passing through the original text and invoking `onError`).

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
