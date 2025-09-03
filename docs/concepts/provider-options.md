# [dev] Provider Options Surface

The middleware reads options from `params.providerOptions.toolCallMiddleware`.

## Public (user-provided)

- `onError?: (message, metadata) => void`
  - Non-fatal reporting hook during parsing (generate/stream) and prompt transform.
  - Plumbed into handlers and forwarded to protocols.
  - Source: `utils/on-error.ts`; used by `transform-handler.ts`, `stream-handler.ts`, `generate-handler.ts`, and protocol parsers.

Example:

```ts
const result = await model.generateText({
  prompt,
  tools,
  providerOptions: {
    toolCallMiddleware: {
      onError: (message, metadata) => console.warn(message, metadata),
      // You may add protocol-specific options here (see below)
    },
  },
});
```

## Internal (not public API; subject to change)

- `originalTools: Array<{ name: string; inputSchema: string }>`
  - Set by `transformParams` to propagate function tool names when providers strip `params.tools`.
  - Read by `getFunctionTools` as a fallback.
  - Source: `transform-handler.ts`, `utils/tools.ts`.

- `toolChoice: { type: "required" } | { type: "tool", toolName }`
  - Injected by `transformParams` when emulating AI SDK tool choice.
  - Checked via `isToolChoiceActive` to trigger the tool-choice fast-path in handlers.
  - Source: `transform-handler.ts`, `utils/tools.ts`, `stream-handler.ts`, `generate-handler.ts`.
  - Note: `type: "none"` is not supported by this middleware.

- `debugSummary: { originalText?: string; toolCalls?: string }`
  - JSON-safe sink for structured parse information that suppresses console logs in `parse` mode.
  - Populated by middleware in both generate and stream paths.
  - `originalText` contains pre-parse origin segments.
  - `toolCalls` is a JSON stringified array of `{ toolName?: string; input?: unknown }`.
  - Source: `generate-handler.ts`, `stream-handler.ts`.

Deprecated/removed:

- `originalToolSchemas` — replaced by the internal `originalTools` propagation.

## Protocol options passthrough

- All fields under `providerOptions.toolCallMiddleware` are forwarded to protocol parsers as `options` in both generate and stream flows.
- Reserved/internal keys include: `onError`, `originalTools`, and `toolChoice`.
- Protocols may read additional keys. Today, `morphXmlProtocol` supports `originalToolSchemas`.

Example (XML coercion using original schemas):

```ts
await model.generateText({
  tools,
  providerOptions: {
    toolCallMiddleware: {
      onError: (m, meta) => console.debug(m, meta),
      originalToolSchemas: {
        get_weather: openAIStyleJsonSchemaForGetWeather,
      },
    },
  },
});
```

Note: Internal options exist only to carry state between transform and parsing phases and may change without notice.
