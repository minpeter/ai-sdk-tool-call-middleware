# Parser Core Examples

Runnable examples for `@ai-sdk-tool/parser`.

Each example demonstrates a distinct behavior. Similar transport patterns are kept only when stream vs non-stream is the point of the example.

Numbering note:

- `parser-core` uses `00-07`
- `rxml-core` uses `20-29`

## Learn first (ai-sdk.dev)

- https://ai-sdk.dev/docs/foundations/tools
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- https://ai-sdk.dev/docs/reference/ai-sdk-core/wrap-language-model
- https://ai-sdk.dev/docs/ai-sdk-core/middleware

## Files

- `src/00-basic-tool-call.ts` — baseline non-streaming tool call with preconfigured middleware
- `src/01-stream-basic-tool-call.ts` — baseline streaming tool call with full stream event handling
- `src/02-tool-choice-required.ts` — `toolChoice: "required"` behavior (non-streaming)
- `src/03-tool-choice-toolname.ts` — `toolChoice: { type: "tool", toolName }` behavior (non-streaming)
- `src/04-stream-tool-choice-required.ts` — `toolChoice: "required"` behavior (streaming)
- `src/05-stream-tool-choice-toolname.ts` — `toolChoice: { type: "tool", toolName }` behavior (streaming)
- `src/06-stream-tool-input-visual-demo.ts` — visualized `tool-input-start/delta/end` for a practical file-write payload
- `src/07-stream-tool-input-visual-many-params-demo.ts` — visualized `tool-input-*` events for a large nested payload

## Run

From repo root after `pnpm install`:

```bash
cd examples/parser-core && pnpm dlx tsx src/01-stream-basic-tool-call.ts
```

Live visual streaming demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/06-stream-tool-input-visual-demo.ts
```

Many-parameter + nested payload visual demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/07-stream-tool-input-visual-many-params-demo.ts
```

Configure your model provider credentials as needed (e.g., OpenRouter key/base URL).
