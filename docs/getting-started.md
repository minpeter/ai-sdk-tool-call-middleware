# Getting Started

This monorepo contains two packages:

- `@ai-sdk-tool/parser`: tool-call parsing middleware for AI SDK
- `@ai-sdk-tool/eval`: evaluation utilities and benchmarks

> Note: Requires AI SDK v5. For AI SDK v4, pin `@ai-sdk-tool/parser@1.0.0`.

## Install

```bash
pnpm add @ai-sdk-tool/parser ai @ai-sdk/openai-compatible zod
# Optional: only if you plan to run benchmarks
pnpm add @ai-sdk-tool/eval
```

### Env setup (example provider)

```bash
export OPENROUTER_API_KEY=your_key
```

## Minimal example (generate)

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, generateText } from "ai";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";
import { z } from "zod";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const { text } = await generateText({
    model: wrapLanguageModel({
      model: openrouter("google/gemma-3-27b-it"),
      middleware: gemmaToolMiddleware,
    }),
    prompt: "What is the weather in my city?",
    tools: {
      get_location: {
        description: "Get the user's city",
        inputSchema: z.object({}),
        execute: async () => ({ city: "New York" }),
      },
      get_weather: {
        description: "Return weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({
          city,
          temperature: 25,
          condition: "sunny",
        }),
      },
    },
  });

  console.log(text);
}

main().catch(console.error);
```

## Minimal example (stream)

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, stepCountIs, streamText } from "ai";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";
import { z } from "zod";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: openrouter("google/gemma-3-27b-it"),
      middleware: gemmaToolMiddleware,
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in my city?",
    stopWhen: stepCountIs(4),
    tools: {
      get_location: {
        description: "Get the user's city",
        inputSchema: z.object({}),
        execute: async () => ({ city: "New York" }),
      },
      get_weather: {
        description: "Return weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({
          city,
          temperature: 25,
          condition: "sunny",
        }),
      },
    },
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") process.stdout.write(part.text);
    if (part.type === "tool-result") console.log(part.output);
  }
}

main().catch(console.error);
```

## Choose a middleware (protocol)

- **gemmaToolMiddleware**: JSON tool calls inside markdown fences. Best for Gemma-like models.
- **xmlToolMiddleware**: XML tool calls. Works well with GLM-style models.
- **hermesToolMiddleware**: JSON payload wrapped in XML tags. For Hermes/Llama-style prompts.

Swap by importing a different middleware; your tool definitions stay the same.

## Tips and limits

- **Tool choice**: supports `required` and `tool` (specific tool). `none` is not supported.
- **Provider-defined tools**: not supported. Pass only custom function tools.
- **Streaming**: you'll receive `text-delta` and `tool-result` parts; the middleware parses calls automatically.

## [dev] Customize or add a protocol

````ts
import { createToolMiddleware, jsonMixProtocol } from "@ai-sdk-tool/parser";

export const customMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol({
    toolCallStart: "```tool_call\n",
    toolCallEnd: "\n```",
    toolResponseStart: "```tool_response\n",
    toolResponseEnd: "\n```",
  }),
  toolSystemPromptTemplate(tools) {
    return `You have access to functions. Return only a fenced tool_call block. ${tools}`;
  },
});
````

- **[dev] Build/test**: `pnpm build`, `pnpm test`, `pnpm dev`
- **[dev] Debug logs**: `DEBUG_PARSER_MW=stream` or `DEBUG_PARSER_MW=parse`
