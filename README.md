<img width="3168" height="1344" alt="AI SDK Tool monorepo banner" src="https://github.com/user-attachments/assets/9a002988-e535-42ac-8baf-56ec8754410f" />

[![npm - parser](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm downloads - parser](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

Tooling for Vercel AI SDK: enable tool calling with models lacking native `tools`, plus evaluation utilities.

- **@ai-sdk-tool/parser**: add tool-calling via middleware; works with any provider supported by AI SDK `wrapLanguageModel`.
- **@ai-sdk-tool/eval**: benchmarks and evaluation helpers (BFCL, JSON generation).

## Usage at a glance

```ts
import { wrapLanguageModel, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { xmlToolMiddleware } from "@ai-sdk-tool/parser";

const client = createOpenAICompatible({
  /* baseURL, apiKey */
});

const result = streamText({
  model: wrapLanguageModel({
    model: client("your-model-name"),
    middleware: xmlToolMiddleware,
  }),
  tools: {
    /* your tools */
  },
  prompt: "Find weather for Seoul today",
});

for await (const part of result.fullStream) {
  // handle text and tool events
}
```
