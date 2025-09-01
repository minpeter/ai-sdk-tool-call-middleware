# @ai-sdk-tool/rxml

Robust XML parser/streamer/builder for AI-generated and real-world XML. RXML focuses on resilience (lenient parsing when possible), JSON Schema–based coercion, efficient streaming, and clean stringification.

## Install

```bash
pnpm add @ai-sdk-tool/rxml
# or
npm i @ai-sdk-tool/rxml
# or
yarn add @ai-sdk-tool/rxml
```

## Quick usage

- Parse with JSON Schema coercion

```ts
import { parse } from "@ai-sdk-tool/rxml";

const schema = {
  type: "object",
  properties: { title: { type: "string" } },
};

const out = parse("<title>Hello</title>", schema);
// => { title: "Hello" }
```

- Stream large XML

```ts
import { createReadStream } from "node:fs";
import { processXMLStream } from "@ai-sdk-tool/rxml";

const stream = createReadStream("./large.xml", "utf8");
for await (const node of processXMLStream(stream)) {
  // node is an RXMLNode or a comment string
}
```

- Stringify objects to XML

```ts
import { stringify } from "@ai-sdk-tool/rxml";

const xml = stringify("root", { title: "Hello" });
```

## More docs

See full documentation at `docs/rxml.md` (in the repository root).
