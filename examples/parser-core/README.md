# Parser Core Examples

Runnable examples for `@ai-sdk-tool/parser` middleware behavior.

## Prerequisites

- Run from repository root.
- Install dependencies first: `pnpm install`.
- Set `OPENROUTER_API_KEY` for examples that call a real model.

## Learn first (AI SDK docs)

- https://ai-sdk.dev/docs/foundations/tools
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- https://ai-sdk.dev/docs/reference/ai-sdk-core/wrap-language-model
- https://ai-sdk.dev/docs/ai-sdk-core/middleware

## Numbering

- `parser-core` examples use `00-07`.
- `rxml-core` examples use `20-29`.

## Files

- `src/00-tool-call.ts` - non-stream baseline tool call.
- `src/01-stream-tool-call.ts` - stream baseline using `fullStream`.
- `src/02-tool-choice-required.ts` - non-stream `toolChoice: "required"`.
- `src/03-tool-choice-fixed.ts` - non-stream fixed tool choice (`toolName`).
- `src/04-stream-tool-choice-required.ts` - stream + required tool choice.
- `src/05-stream-tool-choice-fixed.ts` - stream + fixed tool choice.
- `src/06-stream-tool-input-file.ts` - visualizes `tool-input-start/delta/end` and writes demo output file.
- `src/07-stream-tool-input-nested.ts` - visualizes large nested tool input streaming.
- `src/console-output.ts` - shared output helper used by non-stream examples.

## Run

From repository root:

```bash
pnpm dlx tsx examples/parser-core/src/01-stream-tool-call.ts
```

Streaming tool-input visualization demos:

```bash
pnpm dlx tsx examples/parser-core/src/06-stream-tool-input-file.ts
pnpm dlx tsx examples/parser-core/src/07-stream-tool-input-nested.ts
```

Notes:

- `06` and `07` write demo files to `.demo-output/` under your current working directory.
- Most parser-core examples use `qwen3CoderToolMiddleware` to demonstrate XML-like tool-call parsing in real model output.
