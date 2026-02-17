# RXML Core Examples

Parsing examples using the public `@ai-sdk-tool/parser/rxml` API.

Numbering note: `rxml-core` uses `20-29` to avoid collisions with parser-core examples.

Run

From repo root after `pnpm install`:

```bash
cd examples/rxml-core && pnpm dlx tsx src/20-parse-basic.ts
```

Demos

- `20-parse-basic.ts`: Parse a basic tool-call payload with a schema.
- `21-parse-from-stream.ts`: Collect stream chunks and parse the full XML.
- `22-find-field.ts`: Parse a tool-call and access nested fields.
