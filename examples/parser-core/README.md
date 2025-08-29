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

## Run

From repo root after `pnpm install`:

```bash
cd examples/parser-core && pnpm dlx tsx src/00-stream-tool-call.ts
```

Configure your model provider credentials as needed (e.g., OpenRouter key/base URL).
