# `@ai-sdk-tool/` monorepo

[![npm - parser](https://img.shields.io/npm/v/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![npm downloads - parser](https://img.shields.io/npm/dt/@ai-sdk-tool/parser)](https://www.npmjs.com/package/@ai-sdk-tool/parser)
[![codecov](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware/branch/main/graph/badge.svg)](https://codecov.io/gh/minpeter/ai-sdk-tool-call-middleware)

Monorepo of tooling around AI SDK to enable tool calling and evaluation.

- **@ai-sdk-tool/parser**: middleware to parse tool calls for models without native `tools` support. Works with any provider.
- **@ai-sdk-tool/eval**: benchmarks and evaluation helpers (BFCL, JSON generation).

## Packages

- `packages/parser` — core tool‑call parsing middleware and prebuilt middlewares (`gemmaToolMiddleware`, `hermesToolMiddleware`, `xmlToolMiddleware`).
  - Quickstarts: [packages/parser/README.md](packages/parser/README.md)
  - Official docs reference: [Custom tool call parser](https://ai-sdk.dev/docs/ai-sdk-core/middleware#custom-tool-call-parser)
- `packages/eval` — evaluation utilities (BFCL, JSON generation).  
  – Quickstarts: [packages/eval/README.md](packages/eval/README.md)

## Install (per package)

```bash
pnpm add @ai-sdk-tool/parser
pnpm add @ai-sdk-tool/eval
```

## Examples

- Parser examples: `examples/parser-core/src/` (streaming/non‑streaming, tool choice variants)
- Eval examples: `examples/eval-core/src/`

Run examples locally (after `pnpm install` at repo root):

```bash
cd examples/parser-core && pnpm dlx tsx src/00-stream-tool-call.ts
cd examples/eval-core && pnpm dlx tsx src/bfcl-simple.ts
```

## Development (monorepo)

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

Single‑package development:

```bash
cd packages/parser && pnpm test:watch
cd packages/eval && pnpm dev
```

## Contributing

Issues and PRs are welcome. See `CONTRIBUTING.md` and `AGENTS.md` for architecture and workflow.
