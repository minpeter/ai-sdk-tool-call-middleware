# Parser Core Examples

Runnable examples for `@ai-sdk-tool/parser`.

## Files

- `src/00-tool-call.ts` — basic non‑streaming tool call
- `src/00-stream-tool-call.ts` — streaming tool call
- `src/01-reasoning-tool-call.ts` — reasoning + tool call (non‑streaming)
- `src/01-stream-reasoning-tool-call.ts` — reasoning + tool call (streaming)
- `src/02-choice-required.ts` — tool choice: required
- `src/02-choice-toolname.ts` — tool choice: specific tool name
- `src/02-stream-choice-required.ts` — streaming + required tool
- `src/02-stream-choice-toolname.ts` — streaming + specific tool
- `src/03-stream-tool-input-delta-compare.ts` — user-view comparison: legacy tool-call only vs streaming tool-input deltas, plus raw-delta snapshot vs current parsed-object delta behavior for XML/YAML
- `src/04-stream-tool-input-visual-demo.ts` — visual live demo of `tool-input-start/delta/end` while generating a long file-writing tool input (assistant `text-delta` is intentionally hidden to avoid protocol-markup leakage)
- `src/05-stream-tool-input-visual-many-params-demo.ts` — visual live demo of `tool-input-start/delta/end` for a deeply nested tool payload with many top-level parameters
- `src/06-qwen3coder-protocol-tool-call.ts` — Qwen3CoderToolParser middleware: basic non-streaming tool call
- `src/07-stream-qwen3coder-protocol-tool-input-deltas.ts` — Qwen3CoderToolParser protocol: streaming tool-input deltas + final tool-call (no model API calls)
- `src/08-stream-qwen3coder-protocol-middleware.ts` — Qwen3CoderToolParser middleware: end-to-end streaming with a live model

## Run

From repo root after `pnpm install`:

```bash
cd examples/parser-core && pnpm dlx tsx src/00-stream-tool-call.ts
```

Qwen3CoderToolParser streaming demo without model API calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/07-stream-qwen3coder-protocol-tool-input-deltas.ts
```

Qwen3CoderToolParser middleware streaming demo with live model calls:

```bash
cd examples/parser-core && OPENROUTER_API_KEY=... pnpm dlx tsx src/08-stream-qwen3coder-protocol-middleware.ts
```

Comparison demo without model API calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/03-stream-tool-input-delta-compare.ts
```

Live visual streaming demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/04-stream-tool-input-visual-demo.ts
```

Many-parameter + nested payload visual demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/05-stream-tool-input-visual-many-params-demo.ts
```

Configure your model provider credentials as needed (e.g., OpenRouter key/base URL).
