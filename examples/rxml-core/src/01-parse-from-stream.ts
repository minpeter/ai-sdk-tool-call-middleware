import { Readable } from "node:stream";
import { parseFromStream, type RXMLNode } from "@ai-sdk-tool/rxml";

const DEFAULT_CHUNK_SIZE = 12;
const PUSH_DELAY_MS = 10;

function createAsyncChunkedStream(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE
): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= text.length) {
        this.push(null);
        return;
      }
      const next = text.slice(i, i + chunkSize);
      i += chunkSize;
      setTimeout(() => this.push(next), PUSH_DELAY_MS);
    },
  });
}

async function main() {
  const xml = `<tool_call id="call_1">
  <name>calculate</name>
  <parameters>
    <operation>add</operation>
    <numbers>
      <item>10</item>
      <item>20</item>
      <item>30</item>
    </numbers>
  </parameters>
</tool_call>`;

  const STREAM_CHUNK_SIZE = 9;
  const stream = createAsyncChunkedStream(xml, STREAM_CHUNK_SIZE);
  const nodes = await parseFromStream(stream);

  console.log("Collected", nodes.length, "nodes");
  for (const n of nodes) {
    if (typeof n === "string") {
      console.log("comment/text:", n);
    } else {
      const node = n as RXMLNode;
      console.log(`<${node.tagName}>`, node.attributes, node.children);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
