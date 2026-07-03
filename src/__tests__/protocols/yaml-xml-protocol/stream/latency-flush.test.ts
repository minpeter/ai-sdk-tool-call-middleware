import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

// Regression tests: the streaming parser previously withheld a fixed
// `maxTagLen - 1` tail on every chunk, so short chunks never streamed until
// finish. Only a genuine partial tool-tag suffix may be held back.
describe("yamlXmlProtocol stream text flushing", () => {
  function openParser() {
    const parser = yamlXmlProtocol({}).createStreamParser({ tools });
    return {
      writer: parser.writable.getWriter(),
      reader: parser.readable.getReader(),
    };
  }

  it("streams short text chunks immediately", async () => {
    const { writer, reader } = openParser();

    // Deliberately no close(): parts must arrive while the stream is open.
    const writes = writer.write({ type: "text-delta", id: "1", delta: "Hi!" });

    const collected: LanguageModelV4StreamPart[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { value } = await reader.read();
      if (value) {
        collected.push(value);
      }
    }
    await writes;

    const text = collected
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hi!");

    await writer.close();
  });

  it("still holds back a genuine partial tool tag", async () => {
    const { writer, reader } = openParser();

    const writes = (async () => {
      await writer.write({
        type: "text-delta",
        id: "1",
        delta: "prefix <get_wea",
      });
      await writer.write({
        type: "text-delta",
        id: "1",
        delta: "ther>\ncity: Seoul\n</get_weather>",
      });
    })();

    const collected: LanguageModelV4StreamPart[] = [];
    // text-start, "prefix " delta, then the tool-input lifecycle + tool-call.
    while (collected.filter((p) => p.type === "tool-call").length === 0) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        collected.push(value);
      }
    }
    await writes;
    await writer.close();

    const text = collected
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe("prefix ");

    const toolCall = collected.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
  });
});
