# [dev] Middleware Architecture

The middleware composes with AI SDK `LanguageModelV2Middleware` to provide tool calling for models without native support.

## Responsibilities

- Inject the tool system prompt and tool signatures (`transformParams`)
- Parse model output for tool calls in both streaming and non-streaming modes (`wrapStream`, `wrapGenerate`)
- Surface parsed tool calls to the application, and format tool results back to the model
- Support tool choice fast-paths for structured JSON responses when requested

## Key modules

- `createToolMiddleware` — factory to assemble a middleware with a given protocol
- `transformParams` — injects system prompt, normalizes prompt, sets tool-choice fast path
- `wrapStream` — streams provider output and emits normalized tool-call parts
- `wrapGenerate` — parses batch outputs into normalized content (incl. tool-calls)
- `ToolCallProtocol` — pluggable protocol interface (JSON-mix, Morph-XML, etc.)

See `packages/parser/src/tool-call-middleware.ts` and `packages/parser/src/protocols/*`.

## How it works (end-to-end)

1. `transformParams`
   - Extracts custom function tools (`type: "function"`) and renders a system prompt via `protocol.formatTools` and a provided `toolSystemPromptTemplate`.
   - Normalizes the existing prompt:
     - Assistant tool-call parts are converted to provider-friendly text with `protocol.formatToolCall`.
     - Tool result messages (`role: "tool"`) are mapped to `role: "user"` text via `protocol.formatToolResponse`.
     - Condenses multiple text parts into a single text block and merges consecutive user text messages.
   - Clears `params.tools` (providers may drop/alter them) and propagates tool names internally to `providerOptions.toolCallMiddleware.toolNames` for downstream parsing.
   - Tool choice handling:
     - `toolChoice: { type: "tool", toolName }`: sets `responseFormat` to a strict JSON schema for the selected tool and enables the fast-path.
     - `toolChoice: { type: "required" }`: sets a dynamic JSON schema that requires exactly one of the provided tools and enables the fast-path.
     - `toolChoice: { type: "none" }`: not supported (throws). Use `auto` (default) instead.

2. `wrapStream`
   - If tool-choice fast-path is active, performs a single `generate` call and emits a synthetic `tool-call` followed by `finish`.
   - Otherwise, pipes provider stream through `protocol.createStreamParser`, emitting normalized `tool-call` parts as they arrive.

3. `wrapGenerate`
   - If tool-choice fast-path is active, parses the first text block as JSON `{ name, arguments }` and returns a single `tool-call` content item.
   - Otherwise, runs `protocol.parseGeneratedText` over text parts and returns normalized content (tool-calls + remaining text).

## Tool choice (fast-path)

- Supported: `auto` (default), `tool`, `required`.
- Unsupported: `none` (throws at `transformParams`).
- Behavior:
  - `tool` — forces the model to return a JSON body for that tool; the middleware converts it directly to a tool-call.
  - `required` — forces a JSON body that must match one of the provided tools; converted to a tool-call.
- Implementation details:
  - Activation is internal via `providerOptions.toolCallMiddleware.toolChoice`.
  - Stream and batch paths both parse the JSON body and emit a normalized `tool-call`.

## Provider options and error reporting

- `providerOptions.toolCallMiddleware.onError?: (message, metadata) => void`
  - Non-fatal parse/format issues are surfaced here (e.g., failed JSON parse on fast-path).
- `providerOptions.toolCallMiddleware.toolNames?: string[]`
  - Internal: automatically set by `transformParams` to propagate tool names when providers strip `params.tools`.
- These are internal wiring details used by the middleware; user-facing configuration is through `tools`, `toolChoice`, and the chosen protocol.

## Debugging

- Set `DEBUG_PARSER_MW` to control logging:
  - `off` (default), `stream` (raw + normalized chunks), `parse` (parsed summary with origin highlights)
- Optional style for origin highlighting: `DEBUG_PARSER_MW_STYLE` = `bg` | `inverse` | `underline` | `bold`

## Protocol API (what a protocol must provide)

- `formatTools({ tools, toolSystemPromptTemplate }) => string` — renders the tool system prompt.
- `formatToolCall(toolCall) => string` — renders an assistant tool-call part as text for provider compatibility.
- `formatToolResponse(toolResult) => string` — renders a tool result as text for the next turn.
- `parseGeneratedText({ text, tools, options }) => ContentPart[]` — parses batch text into normalized content.
- `createStreamParser({ tools, options }) => TransformStream` — parses streamed deltas into normalized parts.
- Optional: `extractToolCallSegments({ text, tools }) => string[]` — used only for debug summaries.

See concrete implementations in `packages/parser/src/protocols/json-mix-protocol.ts` and `packages/parser/src/protocols/morph-xml-protocol.ts`.

## Exports and preconfigured middlewares

- `createToolMiddleware` — compose your own middleware with any `ToolCallProtocol`.
- Preconfigured:
  - `gemmaToolMiddleware` — JSON-mix with fenced code blocks for Gemma-style models.
  - `hermesToolMiddleware` — JSON-mix with XML-tag wrapping of tool calls.
  - `xmlToolMiddleware` — Morph-XML protocol for XML-native formats.
- Protocol factories: `jsonMixProtocol`, `morphXmlProtocol`.

Defined in `packages/parser/src/index.ts`.

## Limitations and gotchas

- Provider-defined tools (non `type: "function"`) are not supported by this middleware.
  - If `toolChoice.type === "tool"` references a provider-defined tool, an error is thrown.
- `toolChoice: { type: "none" }` is not supported.
- `transformParams` clears `params.tools` to avoid provider interference; tool names are propagated internally for parsing.
- Arguments are coerced to strings for transport when necessary; protocol implementations define exact formatting.
