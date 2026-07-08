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
      properties: {
        city: { type: "string" },
        unit: { type: "string" },
      },
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

  it("streams ordinary tool_call prose while the stream is open", async () => {
    const { writer, reader } = openParser();

    const writes = writer.write({
      type: "text-delta",
      id: "1",
      delta: "The <tool_call> wrapper is not used here.",
    });

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
    expect(text).toBe("The <tool_call> wrapper is not used here.");

    await writer.close();
  });

  it("holds an unfinished foreign JSON tool_call block for salvage", async () => {
    const { writer, reader } = openParser();
    const out: LanguageModelV4StreamPart[] = [];

    const writes = (async () => {
      await writer.write({
        type: "text-delta",
        id: "1",
        delta:
          '<tool_call>\n{"name":"get_weather","arguments":{"city":"Seoul"}}',
      });
      await writer.close();
    })();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        out.push(value);
      }
    }
    await writes;

    expect(
      out
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
        .join("")
    ).toBe("");
    const call = out.find((p) => p.type === "tool-call");
    expect(call).toMatchObject({ type: "tool-call", toolName: "get_weather" });
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

// Real-world shape observed from Amazon Nova 2 Lite: the model answers the
// YAML-body prompt with XML child tags (the morph-xml body format).
describe("yamlXmlProtocol XML-children fallback", () => {
  it("parses <key>value</key> children when YAML parsing fails (generate)", () => {
    const p = yamlXmlProtocol({});
    const out = p.parseGeneratedText({
      text: "<get_weather>\n<city> Seoul</city>\n<unit> celsius</unit>\n</get_weather>",
      tools,
    });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("parses <key>value</key> children when YAML parsing fails (stream)", async () => {
    const { writer, reader } = (() => {
      const parser = yamlXmlProtocol({}).createStreamParser({ tools });
      return {
        writer: parser.writable.getWriter(),
        reader: parser.readable.getReader(),
      };
    })();

    const writes = (async () => {
      await writer.write({
        type: "text-delta",
        id: "1",
        delta:
          "<get_weather>\n<city> Tokyo</city>\n<unit> celsius</unit>\n</get_weather>",
      });
      await writer.close();
    })();

    const collected: LanguageModelV4StreamPart[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        collected.push(value);
      }
    }
    await writes;

    const call = collected.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(JSON.parse(call.input)).toEqual({
      city: "Tokyo",
      unit: "celsius",
    });
  });

  it("keeps the failure path for mixed prose bodies", () => {
    const p = yamlXmlProtocol({});
    const out = p.parseGeneratedText({
      text: "<get_weather>\nsome prose <city>Seoul</city>\n</get_weather>",
      tools,
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });
});

describe("yamlXmlProtocol XML-children fallback tolerance", () => {
  it("tolerates lines with missing close tags", () => {
    const p = yamlXmlProtocol({});
    const out = p.parseGeneratedText({
      text: "<get_weather>\n<city> Seoul</city>\n<unit>celsius\n</get_weather>",
      tools,
    });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("declines lines containing nested markup in values", () => {
    const p = yamlXmlProtocol({});
    const out = p.parseGeneratedText({
      text: "<get_weather>\n<city>Seoul</city><unit>celsius</unit>\n</get_weather>",
      tools,
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });
});
