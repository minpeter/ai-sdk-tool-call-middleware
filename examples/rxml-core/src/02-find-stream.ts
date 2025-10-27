import {
  findElementByIdStream,
  findElementsByClassStream,
  type RXMLNode,
} from "@ai-sdk-tool/rxml";
import { Readable } from "stream";

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
  <tool_call id="alpha" class="primary">
    <name>search</name>
  </tool_call>
  <tool_call id="beta" class="secondary primary">
    <name>summarize</name>
  </tool_call>
</tools>`;

  const streamForId = createChunkedStream(xml, 7);
  console.log("Find by id=beta:");
  for await (const node of findElementByIdStream(streamForId, "beta")) {
    const n = node as RXMLNode;
    console.log(`<${n.tagName}>`, n.attributes);
  }

  const streamForClass = createChunkedStream(xml, 7);
  console.log("\nFind by class=primary:");
  for await (const node of findElementsByClassStream(
    streamForClass,
    "primary"
  )) {
    const n = node as RXMLNode;
    console.log(`<${n.tagName}>`, n.attributes);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
