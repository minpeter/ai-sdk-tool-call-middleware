## Examples

- **Parser**
  - `examples/parser-core/src/00-tool-call.ts`
  - `examples/parser-core/src/00-stream-tool-call.ts`
  - `examples/parser-core/src/01-reasoning-tool-call.ts`
  - `examples/parser-core/src/01-stream-reasoning-tool-call.ts`
  - `examples/parser-core/src/02-choice-required.ts`
  - `examples/parser-core/src/02-choice-toolname.ts`
  - `examples/parser-core/src/02-stream-choice-required.ts`
  - `examples/parser-core/src/02-stream-choice-toolname.ts`

Run (from repo root after `pnpm install`):

```bash
cd examples/parser-core && pnpm dlx tsx src/00-stream-tool-call.ts
```

- **Eval**
  - `examples/eval-core/src/bfcl-simple.ts`
  - `examples/eval-core/src/json-generation.ts`

Run:

```bash
cd examples/eval-core && pnpm dlx tsx src/bfcl-simple.ts
cd examples/eval-core && pnpm dlx tsx src/json-generation.ts
```

### Prerequisites

- **Install**: from repo root, run `pnpm install`.
- **Node**: v18+ recommended.
- **Provider credentials**: set env vars as needed before running examples.
  - `OPENROUTER_API_KEY`: required for examples using OpenRouter.
  - `OPENAI_API_KEY`: used by `json-generation.ts` for `gpt-4.1-nano`.
  - `FRIENDLI_TOKEN`: used by `bfcl-simple.ts` with Friendli serverless API.

### [dev] Notes

- **Middleware switch**: parser examples show how to swap between `xmlToolMiddleware` and `gemmaToolMiddleware` via commented lines. Choose a provider/model your account can access.
- **Providers**: OpenRouter base URL is `https://openrouter.ai/api/v1`. Friendli serverless base URL is `https://api.friendli.ai/serverless/v1`.
- **Streaming vs non‑streaming**: `00-stream-tool-call.ts` uses streaming (`streamText`), while `00-tool-call.ts` is non‑streaming (`generateText`).
