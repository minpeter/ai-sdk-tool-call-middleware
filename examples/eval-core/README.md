# Eval Core Examples

Runnable examples for `@ai-sdk-tool/eval`.

## Files

- `src/bfcl-simple.ts` — run BFCL simple benchmark across models
- `src/json-generation.ts` — run JSON generation benchmark

## Run

From repo root after `pnpm install`:

```bash
cd examples/eval-core && pnpm dlx tsx src/bfcl-simple.ts
cd examples/eval-core && pnpm dlx tsx src/json-generation.ts
```

Configure your model provider credentials as needed.
