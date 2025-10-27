import { Readable } from "node:stream";
import { processXMLStream, type RXMLNode } from "@ai-sdk-tool/rxml";

function createChunkedStream(text: string, chunkSize = 8): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= text.length) {
        this.push(null);
        return;
      }
      const next = text.slice(i, i + chunkSize);
      i += chunkSize;
      this.push(next);
    },
  });
}

async function main() {
  const xml = `<tools>
  <tool_call id="1" class="primary">
    <name>search</name>
    <parameters><query>AI</query></parameters>
  </tool_call>
  <tool_call id="2" class="secondary">
    <name>summarize</name>
    <parameters><text>long text</text></parameters>
  </tool_call>
</tools>`;

  const stream = createChunkedStream(xml, 10);

  console.log("Streaming nodes as they arrive:\n");
  for await (const node of processXMLStream(stream)) {
    if (typeof node === "string") {
      console.log("comment/text:", node);
    } else {
      const n = node as RXMLNode;
      console.log(`<${n.tagName}>`, n.attributes);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
