# [dev] Handlers Overview

Middleware integrates at three points of AI SDK:

- `transformParams` — Converts `tools` into a system prompt and remaps prompt content
- `wrapStream` — Parses streaming deltas; can switch to toolChoice fast-path
- `wrapGenerate` — Parses non-stream output; can switch to toolChoice fast-path

## transformParams

- Resolves protocol (factory or instance) and serializes only function tools via `protocol.formatTools({ tools, toolSystemPromptTemplate })`.
- Prepends/merges the system prompt. Disables provider-native tools by setting `params.tools = []` and clears `params.toolChoice`.
- Stores `toolNames` in `providerOptions.toolCallMiddleware` for downstream handlers. This is INTERNAL state propagation (not public API).
- Remaps prompt via `convertToolPrompt` (provider-safe):
  - Assistant `tool-call` → `text` using `protocol.formatToolCall`.
  - Assistant unknown parts are stringified; warnings go to `onError` if provided.
  - Assistant `reasoning` parts are preserved as-is.
  - Tool messages (`role: "tool"`) become `user` text via `protocol.formatToolResponse` (then condensed to one text block).
  - Any multi-text message is condensed; adjacent `user` text messages are merged.
- Tool choice handling:
  - `tool` → sets `responseFormat` to JSON with `{ name: const <tool>, arguments: <inputSchema> }`, forwards INTERNAL `providerOptions.toolCallMiddleware.toolChoice` for fast-path.
    - If a provider-defined tool (non-function) matches the requested name/id, throws (provider-defined tools are not supported).
  - `required` → sets dynamic JSON schema via `createDynamicIfThenElseSchema(tools)`, forwards INTERNAL `toolChoice: { type: "required" }`.
  - `none` → not supported (throws). See [Tool Choice](./tool-choice.md).

## wrapStream

- If `isToolChoiceActive(params)` → switches to `toolChoiceStream` (runs `doGenerate`, emits a single `tool-call` then `finish`).
- Otherwise:
  - Calls provider `doStream()`; in debug `stream` logs raw parts; in debug `parse` accumulates raw text for summary.
  - Pipes through `protocol.createStreamParser({ tools, options })` where:
    - `tools` are filtered function tools.
    - `options` includes public `onError` and INTERNAL `providerOptions.toolCallMiddleware` fields.
  - In debug `parse`, on `finish`, logs `extractToolCallSegments` (if implemented by protocol) and a summary of parsed `tool-call`s.

## wrapGenerate

- If `isToolChoiceActive(params)` → runs `doGenerate()`, parses `content[0].text` as JSON `{ name, arguments }`, returns `[ { type: "tool-call", ... } ]` and logs summary in debug `parse`.
- Otherwise:
  - For each `text` content, runs `protocol.parseGeneratedText({ text, tools, options })`.
    - `tools` are function tools, `options` includes public `onError` and INTERNAL `providerOptions.toolCallMiddleware`.
  - Coerces each `tool-call.input` with `fixToolCallWithSchema` using the tool's `inputSchema`.
  - Debug: `stream` logs raw and parsed parts; `parse` logs `extractToolCallSegments` (if available) and a parsed summary.

Additional dev notes (high-signal):

- `isToolChoiceActive(params)` checks INTERNAL `providerOptions.toolCallMiddleware.toolChoice` set by `transformParams`.
- Only function-type tools participate in prompts/parsing; provider-native tools are disabled to avoid conflicts.
- Providers that strip `params.tools` are handled by propagating `toolNames` internally to downstream handlers.

See `packages/parser/src/transform-handler.ts`, `stream-handler.ts`, `generate-handler.ts` for exact behavior. Provider options breakdown: `docs/concepts/provider-options.md` (Public vs INTERNAL).
