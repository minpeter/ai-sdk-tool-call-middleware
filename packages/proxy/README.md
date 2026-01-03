# @ai-sdk-tool/proxy

OpenAI-compatible proxy server for AI SDK tool middleware. This package allows you to expose AI SDK middleware-wrapped language models as standard OpenAI API endpoints, enabling tool calling capabilities for models that don't natively support them.

## Features

- 🔄 OpenAI-compatible `/v1/chat/completions` endpoint
- 🌊 Streaming and non-streaming responses
- 🛠️ Tool calling support for non-native models
- ⚡ Fast and lightweight Fastify server
- 🔧 Configurable CORS and server options
- 📦 Easy integration with existing AI SDK middleware

## Installation

```bash
pnpm add @ai-sdk-tool/proxy
```

## Quick Start

```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { OpenAIProxyServer } from "@ai-sdk-tool/proxy";
import { z } from "zod";

// Create your language model with middleware
const baseModel = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const wrappedModel = wrapLanguageModel({
});

// Configure tools
const tools = {
  get_weather: {
    description: "Get the weather for a given city",
    inputSchema: z.object({ city: z.string() }),
    execute: ({ city }) => {
      // Your weather API logic here
      return { city, temperature: 22, condition: "sunny" };
    },
  },
};

// Start the proxy server
const server = new OpenAIProxyServer({
  model: wrappedModel,
  port: 3000,
  tools,
});

await server.start();
```

## Usage

Once the server is running, you can make standard OpenAI API calls to `http://localhost:3000/v1/chat/completions`:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wrapped-model",
    "messages": [
      {"role": "user", "content": "What is the weather in New York?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the weather for a given city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ],
    "stream": false
  }'
```

### Streaming

Enable streaming by setting `"stream": true` in your request:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wrapped-model",
    "messages": [
      {"role": "user", "content": "Tell me a story"}
    ],
    "stream": true
  }'
```

## API Endpoints

- `POST /v1/chat/completions` - OpenAI-compatible chat completions
- `GET /v1/models` - List available models
- `GET /health` - Health check endpoint

## Configuration

```typescript
interface ProxyConfig {
  model: LanguageModel; // Wrapped language model with middleware
  port?: number; // Server port (default: 3000)
  host?: string; // Server host (default: 'localhost')
  cors?: boolean; // Enable CORS (default: true)
  tools?: Record<string, AISDKTool>; // Available tools (server-registered)
  maxSteps?: number; // Optional: maximum tool-calling steps (experimental)
  logger?: { debug: Function; info: Function; warn: Function; error: Function }; // Optional structured logger
}
```

## Tool Definition

```typescript
interface AISDKTool {
  description: string;
  inputSchema: z.ZodTypeAny; // Zod schema for tool input
  execute?: (params: unknown) => unknown | Promise<unknown>;
}
```

Notes:

- Server merges request-provided tools (schema-only) with server tools (schema + optional execute). Server tools take precedence on name collision. Zod schemas are wrapped for provider compatibility internally.

## Testing

This package uses colocated unit tests next to source files. Key areas covered:

- Request conversion (OpenAI → AI SDK): `openai-request-converter.test.ts`, `openai-request-converter.normalize.test.ts`
- Result conversion (AI SDK → OpenAI): `response-converter.result.test.ts`
- Streaming conversion with stateful handling: `response-converter.stream.test.ts`
- SSE formatting: `response-converter.sse.test.ts`

Run tests:

```bash
pnpm --filter @ai-sdk-tool/proxy test
```

Vitest config includes `src/**/*.test.ts` and excludes `src/test/**` (legacy).

## Internals (Overview)

- OpenAI request → AI SDK params: `src/openai-request-converter.ts`
- AI SDK result/stream → OpenAI response/SSE: `src/response-converter.ts`
- SSE helpers: `createSSEResponse`, `createOpenAIStreamConverter(model)`

Each streaming request creates a single converter instance to maintain per-request state for correct `finish_reason` and tool-call handling.

## License

Apache-2.0
