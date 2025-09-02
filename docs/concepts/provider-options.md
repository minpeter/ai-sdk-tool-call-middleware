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

- `originalToolSchemas: Record<string, unknown>`
  - Optional. If supplied, protocols may use the original provider schemas to coerce argument types.
  - Currently consumed by `morphXmlProtocol` in both generate and stream paths.
  - Source: `protocols/morph-xml-protocol.ts`.

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
