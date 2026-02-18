# RXML Core Examples

Local XML parsing demos using `@ai-sdk-tool/parser/rxml`.

## Prerequisites

- Run from repository root.
- Install dependencies first: `pnpm install`.
- No model provider key is required for these examples.

## Numbering

`rxml-core` examples use `20-29` to avoid collisions with parser-core numbering.

## Files

- `src/20-parse-basic.ts` - parse a simple tool-call XML payload with a schema.
- `src/21-parse-from-stream.ts` - simulate chunked stream input, then parse collected XML.
- `src/22-find-field.ts` - parse and access nested fields from typed output.

## Run

From repository root:

```bash
pnpm dlx tsx examples/rxml-core/src/20-parse-basic.ts
pnpm dlx tsx examples/rxml-core/src/21-parse-from-stream.ts
pnpm dlx tsx examples/rxml-core/src/22-find-field.ts
```
