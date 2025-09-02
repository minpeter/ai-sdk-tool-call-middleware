# [dev] Tool Choice

The middleware emulates tool choice by shaping `responseFormat` and parsing model output.

## Modes

- `required`: model must return a single call to any tool.
- `tool`: model must return a call to the specific tool `toolName`.
- `none`: not supported (error thrown).
- `auto`: pass-through (middleware does not activate tool-choice fast-path).

## How it works

When `toolChoice` is present, `transformParams` constructs a JSON schema and sets `responseFormat`:

- `tool`: schema:

  ```json
  {
    "type": "object",
    "properties": {
      "name": { "const": "<toolName>" },
      "arguments": {
        /* tool.inputSchema */
      }
    },
    "required": ["name", "arguments"]
  }
  ```

- `required`: schema is a dynamic `if/then/else` across all tools (see `createDynamicIfThenElseSchema`).

Additionally:

- For `tool`, `responseFormat` includes `name` and `description` of the tool (hints for some providers).
- `tools` are cleared in the outgoing params; tool schemas are propagated via `providerOptions.toolCallMiddleware.originalTools` for downstream parsing when providers strip `params.tools`.
- Internal activation flag: `providerOptions.toolCallMiddleware.toolChoice` is set to `{ type: "tool" | "required", ... }` to enable the fast-path in stream/generate handlers.

`wrapStream`/`wrapGenerate` in tool-choice mode parse the provider output as raw JSON text `{ name, arguments }` and synthesize a `tool-call` part.

- Generate mode: replaces first text item with a single `tool-call` content.
- Stream mode: internally calls generate once and returns a short stream: one `tool-call` chunk followed by `finish`.

## Usage (AI SDK parameter)

- Force any tool to be called:

  ```ts
  const result = await generateText({
    model,
    prompt: "...",
    tools: {
      get_weather: {
        /* ... */
      },
      get_location: {
        /* ... */
      },
    },
    toolChoice: { type: "required" },
  });
  ```

- Force a specific tool to be called:

  ```ts
  const result = await generateText({
    model,
    prompt: "...",
    tools: {
      get_weather: {
        /* ... */
      },
    },
    toolChoice: { type: "tool", toolName: "get_weather" },
  });
  ```

Note: Provider-defined tools are not supported in this middleware; define custom function tools. If a provider tool matches the requested `toolName`, an error is thrown during `transformParams`.

See `packages/parser/src/transform-handler.ts` and `packages/parser/src/utils/dynamic-tool-schema.ts` for the exact behavior.

## Errors & limitations

- `tool`: throws if the named tool is missing from `params.tools`, or if any provider-defined tool matches the requested identifier.
- `required`: throws if `params.tools` is empty; provider-defined tools are not supported (rejected during schema build).
- Model output must be a pure JSON object with fields `name` and `arguments` in the first text item; non-JSON is reported via `onError` and coerced to an empty call.
- Only a single tool call is supported per response in tool-choice mode; parallel/multiple calls are not yet supported.
