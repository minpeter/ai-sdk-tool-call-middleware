# [dev] Streaming Algorithms

This page summarizes how streaming tool-call parsing works inside the protocols. The parsers transform a stream of `text-delta` parts into structured `tool-call` parts while preserving regular text via `text-start`/`text-delta`/`text-end` events.

Notes common to both protocols:

- Emitted parts: `text-start` → `text-delta` → `text-end` for text, `tool-call` when a call completes, `finish` at the end.
- Errors do not throw: the original text for the failed segment is emitted, and `options.onError` is invoked if provided.
- A debugging summary is available when parse debug is enabled; it uses `extractToolCallSegments` to show original matched segments.

## JSON-mix protocol

Defaults and configuration:

- Tags: `toolCallStart = "<tool_call>"`, `toolCallEnd = "</tool_call>"`. Tool responses (`<tool_response>...</tool_response>`) can be formatted but are not parsed in streaming.
- Arguments parsing: uses RJSON (Robust JSON) via `RJSON.parse`, tolerant of minor model noise: unquoted keys, comments, trailing commas, etc.

State:

- `isInsideToolCall: boolean`
- `buffer: string`
- `currentToolCallJson: string`
- `currentTextId: string | null`
- `hasEmittedTextStart: boolean`

Algorithm (simplified):

1. Append each `text-delta` to `buffer`.
2. While a complete start/end tag is available:
   - If outside a call, emit the safe prefix as text and on `<tool_call>` enter call, reset `currentToolCallJson`.
   - If inside a call and `</tool_call>` is found, parse `currentToolCallJson` with `RJSON.parse` and emit a `tool-call` (closing any open text first). On parse failure, emit the original `"<tool_call>... </tool_call>"` as text and call `options.onError`.
3. When outside a call, avoid leaking partial start tags by keeping a possible suffix using `getPotentialStartIndex`; emit only the safe prefix.
4. On `finish`:
   - If inside a call, emit the leftover as text (prefixed with `<tool_call>`), then close any open text.
   - If not inside a call, flush remaining `buffer` as text and close any open text.

Resilience:

- `getPotentialStartIndex` prevents emitting partial start tags.
- `RJSON.parse` accepts relaxed JSON commonly produced by models.
- `options.onError` receives a message and the original segment on failures.

Source: `packages/parser/src/protocols/json-mix-protocol.ts`.

## Morph-XML protocol

Detection and schemas:

- Only known tool names are considered: the parser scans for the earliest `<name>` where `name ∈ tools.map(t => t.name)`.
- Arguments are parsed by RXML (Robust XML) via `RXML.parse`, which applies best-effort parsing and heuristics to handle noisy/unstructured model XML, then coerced with `coerceBySchema` using provider-original schemas when available (via `options.originalToolSchemas`), otherwise the transformed `inputSchema`.

State:

- `buffer: string`
- `currentToolCall: { name, content } | null`
- `currentTextId: string | null`

Algorithm (simplified):

1. Append each `text-delta` to `buffer`.
2. If inside a call, search for its closing tag `</name>`; when found, slice the content, parse XML, coerce by schema, emit `tool-call`. On failure, emit the original `<name>... </name>` text and call `options.onError`.
3. If not inside a call, find the earliest `<name>` across known tools, flush preceding text, enter that call and continue.
4. On `flush`/`finish`, any unfinished call is emitted as original text; otherwise flush remaining text and close open text blocks.

Coercion heuristics (pre-schema):

- Text nodes: unwrap `#text`.
- Repeated tags: become arrays.
- `<item>` lists: become arrays; numeric-looking strings are converted to numbers when safe.
- Numeric-keyed objects (`{"0":..., "1":...}`): become tuples/arrays in index order.

Source: `packages/parser/src/protocols/morph-xml-protocol.ts`.

## Tool-choice streaming path

When explicit tool choice is active, the normal streaming parser is bypassed. The system performs a non-stream generate, parses a single JSON object `{ name, arguments }` from the first text block, then emits:

1. one `tool-call` part with `input = JSON.stringify(arguments)`
2. a `finish` part with `finishReason = "tool-calls"`

Errors parsing this JSON call `options.onError` and default to `{}`.

Source: `packages/parser/src/stream-handler.ts` (`toolChoiceStream`).
