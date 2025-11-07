# Proxy Core Example

This example demonstrates how to use the `@ai-sdk-tool/proxy` package to create an OpenAI-compatible HTTP server that exposes AI SDK middleware capabilities.

## Setup

1. Install dependencies:

```bash
pnpm install
```

1. Set up environment variables:

```bash
export OPENROUTER_API_KEY="your-openrouter-api-key"
```

## Running the Example

1. Start the proxy server:

```bash
pnpm start
```

1. In another terminal, test the proxy:

```bash
pnpm test
```

## Manual Testing with curl

### Test simple chat (non-streaming)

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wrapped-model",
    "messages": [
      {"role": "user", "content": "Hello! How are you?"}
    ],
    "stream": false
  }'
```

### Test tool calling

```bash
curl -X POST http://localhost:3004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wrapped-model",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"}
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
    "stream": true
  }'
```

### Test streaming

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wrapped-model",
    "messages": [
      {"role": "user", "content": "Write a short poem about coding"}
    ],
    "stream": true
  }'
```

### Test health endpoint

```bash
curl http://localhost:3000/health
```

### Test models endpoint

```bash
curl http://localhost:3000/v1/models
```

## What This Example Shows

1. **Model Wrapping**: How to wrap a language model with tool middleware
2. **Tool Definition**: How to define tools with Zod schemas and execute functions
3. **Server Configuration**: How to configure and start the proxy server
4. **OpenAI Compatibility**: How the proxy responds to standard OpenAI API requests
5. **Streaming Support**: How streaming responses work with SSE format
6. **Tool Execution**: How tools are automatically called and results integrated

## Integration with Other Applications

Once the proxy server is running, any application that supports OpenAI API can connect to it, including:

- **ChatGPT clients** (point to `http://localhost:3000/v1/chat/completions`)
- **LangChain applications** (use OpenAI integration with custom base URL)
- **Custom applications** using OpenAI SDK or fetch requests

This enables you to add advanced tool calling capabilities to models that don't natively support them, without modifying the client application code!
