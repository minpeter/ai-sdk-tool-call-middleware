# RXML (Robust XML)

RXML is a robust XML parser/streamer/builder. It safely handles malformed or noisy XML often produced by models, preserves original content where needed, and supports JSON Schema-based type coercion. It is optimized for tool calling, structured data extraction, and large XML streaming.

## Key features

- Parsing: `parse`, `parseWithoutSchema`, `parseNode`, `simplify`
- Streaming: `XMLTransformStream`, `createXMLStream`, `parseFromStream`, `processXMLStream`, `findElementByIdStream`, `findElementsByClassStream`
- Schema integration: `coerceDomBySchema`, `domToObject`, `getPropertySchema`, `getStringTypedProperties`, `processArrayContent`, `processIndexedTuple`
- Stringification: `stringify`, `stringifyNode`, `stringifyNodes`, `toContentString`
- Error types: `RXMLParseError`, `RXMLCoercionError`, `RXMLStreamError`, `RXMLStringifyError`, `RXMLDuplicateStringTagError`
- Options: `textNodeName`, `throwOnDuplicateStringTags`, `keepComments`, `keepWhitespace`, `noChildNodes`, `onError`

## Installation and import

```ts
import {
  // Core
  parse,
  parseWithoutSchema,
  parseNode,
  simplify,
  // Streaming
  createXMLStream,
  parseFromStream,
  processXMLStream,
  findElementByIdStream,
  findElementsByClassStream,
  // Builders
  stringify,
  stringifyNode,
  stringifyNodes,
  toContentString,
  // Schema
  coerceDomBySchema,
} from "@ai-sdk-tool/rxml";
```

## Parsing

- `parse(xmlInner, schema, options)`:
  - Schema-aware parsing and type coercion powered by JSON Schema
  - Robustness features: duplicate string tag checks/tolerance, placeholder-based raw content preservation, conditional root unwrapping
- `parseWithoutSchema(xmlString, options)`:
  - Lenient parsing without a schema. Throws for obvious errors; otherwise returns partial results when possible
- `parseNode(xmlString)`:
  - Parse a single node and return an `RXMLNode`
- `simplify(children)`:
  - TXML-style simplified structure (same tags grouped into arrays, single-item arrays flattened)

Example:

```ts
const schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    items: { type: "array", items: { type: "number" } },
  },
};

const xml = "<title>Hi</title><items><item>1</item><item>2</item></items>";
const result = parse(xml, schema);
// => { title: "Hi", items: [1, 2] }
```

## Streaming

Ideal for large XML or model streaming output.

- `XMLTransformStream` / `createXMLStream`:
  - Transform stream that emits complete elements as `RXMLNode`
- `parseFromStream(readable, offset?, options?)`:
  - Parse the whole stream and return `(RXMLNode | string)[]`
- `processXMLStream(readable)`:
  - Iterate elements with `for await ... of`
- `findElementByIdStream`, `findElementsByClassStream`:
  - Async generators that filter by `id` or `class`

```ts
import { createReadStream } from "node:fs";

const stream = createReadStream("./large.xml", "utf8");
for await (const node of processXMLStream(stream)) {
  // node is an RXMLNode or a comment string
}
```

## Schema integration and coercion

- `domToObject(nodes, schema, textNodeName?)`:
  - Convert TXML DOM to a flat object, preserving attributes as `@_attr`
- `coerceDomBySchema(obj, schema)`:
  - JSON Schema-based coercion and normalization
- Special handling for string properties:
  - Extract full raw inner content, handle duplicates (configurable), restore from placeholders, trim whitespace
- Arrays/tuples:
  - `<item>` wrapper pattern, numeric index keys (tuples), string-array normalization

```ts
const xml = "<items><item> 1 </item><item>2</item></items>";
const schema = {
  type: "object",
  properties: { items: { type: "array", items: { type: "number" } } },
};
const out = parse(xml, schema);
// => { items: [1, 2] }
```

## Stringification

- `stringify(rootTag, obj, { format = true, suppressEmptyNode = false })`:
  - Convert objects to XML with XML declaration, indentation, and empty-node suppression
- `stringifyNode(node)` / `stringifyNodes(nodes)`:
  - Serialize parsed nodes back to XML strings
- Attribute conventions:
  - Use `@name` or `_attributes` for attributes, and `#text` / `_text` for text content

```ts
const xml = stringify("root", {
  "@version": "1.0",
  title: "Hello",
  meta: { _attributes: { id: 1 }, "#text": "ok" },
});
```

## Options and error handling

- Common options:
  - `textNodeName` (default `#text`): key name for text nodes
  - `throwOnDuplicateStringTags` (default `true`): whether to throw on duplicate string-typed tags
  - `keepComments`, `keepWhitespace`: preserve comments/whitespace
  - `noChildNodes`: additional tag names that do not contain children
  - `onError(message, context?)`: warning hook used in lenient modes
- Error types:
  - `RXMLParseError(line?, column?)`, `RXMLCoercionError`, `RXMLStreamError`, `RXMLStringifyError`, `RXMLDuplicateStringTagError`

## Tips

- If the output is wrapped in a single root, but the schema does not expect it, RXML can auto-unwrap before coercion.
- When string properties contain constructs like `<!DOCTYPE ...>`, RXML replaces inner content with placeholders during parsing and restores the original content later.
- In streaming mode, events are emitted per complete element to keep memory usage predictable.

## Examples

- See unit/integration tests under `packages/rxml/tests/`.
- For real-world usage, check how the parser package’s XML protocols integrate with RXML.
