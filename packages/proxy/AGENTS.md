# packages/proxy

OpenAI-compatible proxy server exposing AI SDK middleware-wrapped models.

## STRUCTURE

```
src/
├── server.ts                    # OpenAIProxyServer class
├── openai-request-converter.ts  # OpenAI -> AI SDK conversion
├── response-converter.ts        # AI SDK -> OpenAI conversion
├── response-utils.ts            # ID generation, timestamps
├── types.ts                     # Shared types
├── converters.ts                # Legacy compat exports
└── *.test.ts                    # Colocated tests
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add endpoint | `server.ts` - `setupRoutes()` |
| Fix request conversion | `openai-request-converter.ts` |
| Fix response format | `response-converter.ts` |
| Fix streaming | `createOpenAIStreamConverter()` |

## API ENDPOINTS

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | OpenAI-compatible chat |
| GET | `/v1/models` | List available models |
| GET | `/health` | Health check |

## USAGE

```typescript
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";

const server = new OpenAIProxyServer({
  model: wrappedModel,  // AI SDK model with middleware
  port: 3000,
  tools: {              // Server-side tools (with execute)
    get_weather: {
      description: "...",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temp: 22 }),
    },
  },
});

await server.start();
```

## TOOL MERGING

Server merges request tools (schema-only) with server tools (schema + execute):
- Server tools override request tools on name collision
- Zod schemas wrapped via `zodSchema()` for provider compatibility

## STREAMING

- SSE format: `data: {...}\n\n`
- Terminal: `data: [DONE]\n\n`
- Converter maintains per-request state for `finish_reason`

## LOGGING

```typescript
new OpenAIProxyServer({
  logging: {
    requests: true,      // Log incoming requests
    conversions: true,   // Log AI SDK conversions
    streamChunks: true,  // Log SSE chunks
  },
});
```

## CONVENTIONS

- Fastify server with CORS enabled by default
- `biome-ignore lint/suspicious/noExplicitAny` at SDK boundaries
- Tests colocated: `*.test.ts` next to source

## TESTS

```bash
pnpm test

# Test coverage areas:
# - openai-request-converter.test.ts - Request normalization
# - response-converter.result.test.ts - Non-streaming responses
# - response-converter.stream.test.ts - Streaming with state
# - response-converter.sse.test.ts - SSE formatting
```
