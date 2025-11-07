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
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { gemmaToolMiddleware } from '@ai-sdk-tool/parser';
import { wrapLanguageModel } from 'ai';
import { OpenAIProxyServer } from '@ai-sdk-tool/proxy';
import { z } from 'zod';

// Create your language model with middleware
const baseModel = createOpenAICompatible({
  name: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const wrappedModel = wrapLanguageModel({
  model: baseModel('google/gemma-3-27b-it'),
  middleware: gemmaToolMiddleware,
});

// Configure tools
const tools = {
  get_weather: {
    description: 'Get the weather for a given city',
    parameters: z.object({ city: z.string() }),
    execute: ({ city }) => {
      // Your weather API logic here
      return { city, temperature: 22, condition: 'sunny' };
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
  model: LanguageModel;           // Wrapped language model with middleware
  port?: number;                  // Server port (default: 3000)
  host?: string;                  // Server host (default: '0.0.0.0')
  cors?: boolean;                 // Enable CORS (default: true)
  tools?: Record<string, AISDKTool>; // Available tools
  maxSteps?: number;              // Maximum tool call steps (default: 10)
}
```

## Tool Definition

```typescript
interface AISDKTool {
  description: string;
  parameters: z.ZodSchema;
  execute?: (params: any) => any | Promise<any>;
}
```

## License

Apache-2.0
