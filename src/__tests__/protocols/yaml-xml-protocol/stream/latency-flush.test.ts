import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  collectTextDeltas,
  requireToolCall,
  runGeneratedJsonRepair,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";

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

function openParser() {
  const parser = yamlXmlProtocol({}).createStreamParser({ tools });
  return {
    writer: parser.writable.getWriter(),
    reader: parser.readable.getReader(),
  };
}

async function textBeforeClose(delta: string): Promise<string> {
  const { writer, reader } = openParser();
  const write = writer.write({ type: "text-delta", id: "1", delta });
  const collected: LanguageModelV4StreamPart[] = [];
  for (let event = 0; event < 2; event += 1) {
    const result = await reader.read();
    if (result.value !== undefined) {
      collected.push(result.value);
    }
  }
  await write;
  await writer.close();
  return collectTextDeltas(collected);
}

function generatedCall(text: string) {
  const parts = runGeneratedJsonRepair({
    protocol: yamlXmlProtocol({}),
    text,
    tools,
  });
  const call = parts.find((part) => part.type === "tool-call");
  if (call?.type !== "tool-call") {
    throw new TypeError("Expected generated tool-call part");
  }
  return call;
}

async function streamedCall(chunks: readonly string[]) {
  const parts = await runProtocolTextStream({
    protocol: yamlXmlProtocol({}),
    tools,
    id: "1",
    chunks,
  });
  return { parts, call: requireToolCall(parts) };
}

// Regression tests: the streaming parser previously withheld a fixed
// `maxTagLen - 1` tail on every chunk, so short chunks never streamed until
// finish. Only a genuine partial tool-tag suffix may be held back.
describe("yamlXmlProtocol stream text flushing", () => {
  it("streams short text chunks immediately", async () => {
    expect(await textBeforeClose("Hi!")).toBe("Hi!");
  });

  it("streams ordinary tool_call prose while the stream is open", async () => {
    const prose = "The <tool_call> wrapper is not used here.";
    expect(await textBeforeClose(prose)).toBe(prose);
  });

  it("holds an unfinished foreign JSON tool_call block for salvage", async () => {
    const { parts, call } = await streamedCall([
      '<tool_call>\n{"name":"get_weather","arguments":{"city":"Seoul"}}',
    ]);
    expect(collectTextDeltas(parts)).toBe("");
    expect(call).toMatchObject({ type: "tool-call", toolName: "get_weather" });
  });

  it("still holds back a genuine partial tool tag", async () => {
    const { parts, call } = await streamedCall([
      "prefix <get_wea",
      "ther>\ncity: Seoul\n</get_weather>",
    ]);
    expect(collectTextDeltas(parts)).toBe("prefix ");
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });
});

// Real-world shape observed from Amazon Nova 2 Lite: the model answers the
// YAML-body prompt with XML child tags (the morph-xml body format).
describe("yamlXmlProtocol XML-children fallback", () => {
  it("parses <key>value</key> children when YAML parsing fails (generate)", () => {
    const call = generatedCall(
      "<get_weather>\n<city> Seoul</city>\n<unit> celsius</unit>\n</get_weather>"
    );
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul", unit: "celsius" });
  });

  it("parses <key>value</key> children when YAML parsing fails (stream)", async () => {
    const { call } = await streamedCall([
      "<get_weather>\n<city> Tokyo</city>\n<unit> celsius</unit>\n</get_weather>",
    ]);
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo", unit: "celsius" });
  });

  it("keeps the failure path for mixed prose bodies", () => {
    const parts = runGeneratedJsonRepair({
      protocol: yamlXmlProtocol({}),
      text: "<get_weather>\nsome prose <city>Seoul</city>\n</get_weather>",
      tools,
    });
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
  });
});

describe("yamlXmlProtocol XML-children fallback tolerance", () => {
  it("tolerates lines with missing close tags", () => {
    const call = generatedCall(
      "<get_weather>\n<city> Seoul</city>\n<unit>celsius\n</get_weather>"
    );
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul", unit: "celsius" });
  });

  it("declines lines containing nested markup in values", () => {
    const parts = runGeneratedJsonRepair({
      protocol: yamlXmlProtocol({}),
      text: "<get_weather>\n<city>Seoul</city><unit>celsius</unit>\n</get_weather>",
      tools,
    });
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
  });
});
