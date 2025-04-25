# Custom tool call parser for AI SDK

> [!NOTE]
> Depends on AI SDK v5 release, if you wish to use it on v4, please pin the package version to 1.0.0


Allows tool calls to be used in the AI ​​SDK framework regardless of the model.

## Why This Exists

Many self‑hosted or third‑party model endpoints (vLLM, MLC‑LLM, Ollama, OpenRouter, etc.) don’t yet expose the OpenAI‑style `tools` parameter, forcing you to hack together tool parsing.  
This project provides a flexible middleware that:

- Parses tool calls from streaming or batch responses  
- Supports Hermes and Gemma formats  
- Llama, Mistral, and JSON formats are coming soon
- Gain complete control over the tool call system prompt.

## Installation

```bash
pnpm install @ai-sdk-tool/parser
```

---

## Example: Gemma3‑Style Middleware

See `examples/core/src/00-stream-tool-call.ts` for the full demo:

```typescript
// filepath: examples/core/src/00-stream-tool-call.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, streamText } from 'ai';
import { gemmaToolMiddleware } from '@ai-sdk-tool/parser';

const openrouter = createOpenAICompatible({ /* ... */ });

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: openrouter('google/gemma-3-27b-it'),
      middleware: gemmaToolMiddleware,
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
