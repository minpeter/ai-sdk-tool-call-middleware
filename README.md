# `@ai-sdk-tool/` monorepo

[![npm - parser](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm downloads - parser](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm - eval](https://img.shields.io/npm/v/@ai-sdk-tool/eval)](https://www.npmjs.com/package/@ai-sdk-tool/eval)
[![npm downloads - eval](https://img.shields.io/npm/dt/@ai-sdk-tool/eval)](https://www.npmjs.com/package/@ai-sdk-tool/eval)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

Tooling for Vercel AI SDK: enable tool calling with models lacking native `tools`, plus evaluation utilities.

- **@ai-sdk-tool/parser**: add tool-calling via middleware; works with any provider supported by AI SDK `wrapLanguageModel`.
- **@ai-sdk-tool/eval**: benchmarks and evaluation helpers (BFCL, JSON generation).

Note: Requires AI SDK v5. For AI SDK v4, use `@ai-sdk-tool/parser@1.0.0`.

## Packages

- `packages/parser` — core tool‑call parsing middleware and prebuilt middlewares (`gemmaToolMiddleware`, `hermesToolMiddleware`, `xmlToolMiddleware`).
  - Quickstarts: [packages/parser/README.md](packages/parser/README.md)
  - Official docs reference: [Custom tool call parser](https://ai-sdk.dev/docs/ai-sdk-core/middleware#custom-tool-call-parser)
- `packages/eval` — evaluation utilities (BFCL, JSON generation).  
  – Quickstarts: [packages/eval/README.md](packages/eval/README.md)

### Choose a middleware (at a glance)

- **gemmaToolMiddleware**: JSON tool calls inside markdown fences. Best for Gemma-like models.
- **xmlToolMiddleware**: Plain XML tool calls. Good fit for GLM/GLM-like models.
- **hermesToolMiddleware**: JSON payload wrapped in `<tool_call>` XML tags. Hermes/Llama-style prompts.

## Install (per package)

```bash
pnpm add @ai-sdk-tool/parser
pnpm add @ai-sdk-tool/eval
```

## Usage at a glance

```ts
import { wrapLanguageModel, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";

const client = createOpenAICompatible({
  /* baseURL, apiKey */
});

const result = streamText({
  model: wrapLanguageModel({
    model: client("google/gemma-3-27b-it"),
    middleware: gemmaToolMiddleware,
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

## Examples

- Parser examples: `examples/parser-core/src/` (streaming/non‑streaming, tool choice variants)
- Eval examples: `examples/eval-core/src/`

Run examples locally (after `pnpm install` at repo root):

```bash
cd examples/parser-core && pnpm dlx tsx src/00-stream-tool-call.ts
cd examples/eval-core && pnpm dlx tsx src/bfcl-simple.ts
```

## [dev] Development (monorepo)

This is a pnpm workspace managed by Turborepo.

```bash
# install deps
pnpm install

# build/lint/test all packages
pnpm build
pnpm test
pnpm check-types
pnpm lint
pnpm lint:fix
pnpm fmt
pnpm fmt:fix

# develop (watch builds)
pnpm dev
```

### [dev] Requirements

- Node >= 18
- pnpm 9.x (repo sets `packageManager`)

### Single‑package development

```bash
cd packages/parser && pnpm test:watch
cd packages/eval && pnpm dev
```

## [dev] Contributing

Issues and PRs are welcome. See `CONTRIBUTING.md` and `AGENTS.md` for architecture and workflow.

---

Full docs: [docs/index.md](docs/index.md)

## License

Licensed under Apache License 2.0. See `LICENSE` for full terms. If you distribute binaries or source, include the `NOTICE` file as required by the license.
