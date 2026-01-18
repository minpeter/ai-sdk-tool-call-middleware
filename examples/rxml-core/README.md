# RXML Core Examples

Parsing examples using the public `@ai-sdk-tool/parser/rxml` API.

Run

From repo root after `pnpm install`:

```bash
cd examples/rxml-core && pnpm dlx tsx src/00-stream-basic.ts
```

Demos

- `00-stream-basic.ts`: Parse a basic tool-call payload with a schema.
- `01-parse-from-stream.ts`: Collect stream chunks and parse the full XML.
- `02-find-stream.ts`: Parse a tool-call and access nested fields.
