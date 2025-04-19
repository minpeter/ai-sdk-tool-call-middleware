# 🚀 Custom Tool Parser for Open Source Models

Make any Open‑Source LLM tool‑ready in your AI SDK projects—no matter which serving framework you use.

## 🌟 Why This Exists

Many self‑hosted or third‑party model endpoints (vLLM, MLC‑LLM, Ollama, OpenRouter, etc.) don’t yet expose the OpenAI‑style `tools` parameter, forcing you to hack together tool parsing.  
This project provides a flexible middleware that:

- Parses tool calls from streaming or batch responses  
- Supports Hermes and Gemma formats  
- Llama, Mistral, and JSON formats are coming soon  
- Handles interleaved or “chatty” tool calls  
- Corrects common issues in small models (extra markdown fences, semicolon separators)

## 🔧 Installation

```bash
pnpm install @ai-sdk-tool/parser
```

## 🎯 Quickstart

1. Wrap your model with the provided middleware  
2. Stream or generate text as usual  
3. Intercept tool calls as `tool-result` events

---

## 🔌 Example: Hermes‑Style Middleware

See `examples/src/hermes-middleware-example.ts` for the full demo:

```typescript
// filepath: examples/src/hermes-middleware-example.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, streamText } from 'ai';
import { hermesToolMiddleware } from './hermes-middleware';

const openrouter = createOpenAICompatible({ /* ... */ });

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: openrouter('google/gemma-3-27b-it'),
      middleware: hermesToolMiddleware,
    }),
    system: 'You are a helpful assistant.',
    prompt: 'What is the weather in my city?',
    maxSteps: 4,
    tools: {
      get_location: { /* ... */ },
      get_weather: { /* ... */ },
    },
  });

  for await (const part of result.fullStream) {
    // ...handling text-delta and tool-result...
  }
}

main().catch(console.error);
```

---

## 🤝 Contributing

• Feel free to open issues or PRs—especially for new model formats.  
• See `CONTRIBUTING.md` for guidelines.
