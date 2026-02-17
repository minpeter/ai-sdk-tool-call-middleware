import { Readable } from "node:stream";
import { parse } from "@ai-sdk-tool/parser/rxml";

const DEFAULT_CHUNK_SIZE = 12;
const PUSH_DELAY_MS = 10;
const STREAM_CHUNK_SIZE = 9;

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

async function collectStream(stream: Readable): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += chunk.toString();
  }
  return out;
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

  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string" },
          numbers: { type: "array", items: { type: "number" } },
        },
      },
    },
  };

  const stream = createAsyncChunkedStream(xml, STREAM_CHUNK_SIZE);
  const fullXml = await collectStream(stream);
  const result = parse(fullXml, schema);

  console.log("Parsed result from stream:", result);
}

main().catch((error) => {
  console.error("Failed to parse XML from stream", error);
});
