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

## Run

From repo root after `pnpm install`:

```bash
cd examples/parser-core && pnpm dlx tsx src/00-stream-tool-call.ts
```

Comparison demo without model API calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/03-stream-tool-input-delta-compare.ts
```

Live visual streaming demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/04-stream-tool-input-visual-demo.ts
```

Configure your model provider credentials as needed (e.g., OpenRouter key/base URL).
