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

- `src/00-tool-call.ts` — Non-stream: baseline weather tool call.
- `src/01-stream-tool-call.ts` — Streaming: baseline tool call with `fullStream` events.
- `src/02-tool-choice-required.ts` — Non-stream: force tool usage with `toolChoice: "required"`.
- `src/03-tool-choice-fixed.ts` — Non-stream: lock to one tool with `toolChoice.toolName`.
- `src/04-stream-tool-choice-required.ts` — Streaming: force tool usage with `toolChoice: "required"`.
- `src/05-stream-tool-choice-fixed.ts` — Streaming: lock to one tool with `toolChoice.toolName`.
- `src/06-stream-tool-input-file.ts` — Streaming: visualize `tool-input-start/delta/end` during file write.
- `src/07-stream-tool-input-nested.ts` — Streaming: visualize `tool-input-*` for a large nested payload.

## Run

From repo root after `pnpm install`:

```bash
cd examples/parser-core && pnpm dlx tsx src/01-stream-tool-call.ts
```

Live visual streaming demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/06-stream-tool-input-file.ts
```

Many-parameter + nested payload visual demo with real model calls:

```bash
cd examples/parser-core && pnpm dlx tsx src/07-stream-tool-input-nested.ts
```

Configure your model provider credentials as needed (e.g., OpenRouter key/base URL).
