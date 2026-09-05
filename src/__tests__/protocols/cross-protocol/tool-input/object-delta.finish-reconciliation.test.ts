import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  collectTextDeltas,
  observeObjectDeltas,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string" },
    },
    required: ["location"],
  },
};

const strictNameTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "bad_tool",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
};

function expectClosedWithoutToolCall(
  out: Awaited<ReturnType<typeof runProtocolTextStream>>
): void {
  const { starts, ends } = selectToolInputTimeline(out);
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(out.some((part) => part.type === "tool-call")).toBe(false);
}

describe("XML/YAML finish reconciliation policy", () => {
  it("xml/yaml finish reconciliation emits final suffix so joined deltas equal final tool input", async () => {
    const [xml, yaml] = await Promise.all([
      observeObjectDeltas({
        id: "xml-finish-reconciliation",
        protocol: morphXmlProtocol(),
        tools: [weatherTool],
        chunks: [
          "<get_weather>\n<location>Bus",
          "an</location>\n<unit>celsius</unit>\n",
        ],
      }),
      observeObjectDeltas({
        id: "yaml-finish-reconciliation",
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather>\nlocation: Busan\nunit: celsius\n"],
      }),
    ]);

    const xmlCall = xml.toolCall;
    const yamlCall = yaml.toolCall;
    const xmlJoined = xml.joinedInput;
    const yamlJoined = yaml.joinedInput;

    expect(xmlJoined).toBe(xmlCall.input);
    expect(yamlJoined).toBe(yamlCall.input);
    expect(JSON.parse(xmlCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
    expect(JSON.parse(yamlCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
  });

  it("xml finish on unclosed malformed tool call closes stream without raw fallback by default", async () => {
    const out = await runProtocolTextStream({
      id: "xml-malformed-default",
      protocol: morphXmlProtocol(),
      tools: [strictNameTool],
      chunks: ["<bad_tool><name>first</name><name>second</name>"],
    });

    expectClosedWithoutToolCall(out);
    expect(collectTextDeltas(out)).not.toContain("<bad_tool>");
  });

  it("xml finish on unclosed malformed tool call can emit raw fallback when enabled", async () => {
    const out = await runProtocolTextStream({
      id: "xml-malformed-raw",
      protocol: morphXmlProtocol(),
      tools: [strictNameTool],
      parserOptions: { emitRawToolCallTextOnError: true },
      chunks: ["<bad_tool><name>first</name><name>second</name>"],
    });

    expectClosedWithoutToolCall(out);
    const text = collectTextDeltas(out);
    expect(text).toContain("<bad_tool>");
    expect(text).toContain("<name>first</name>");
  });

  it("yaml finish on malformed unclosed tool call can emit raw fallback when enabled", async () => {
    const out = await runProtocolTextStream({
      id: "yaml-malformed-raw",
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
      parserOptions: { emitRawToolCallTextOnError: true },
      chunks: ["<get_weather>\n["],
    });

    expectClosedWithoutToolCall(out);
    expect(collectTextDeltas(out)).toContain("<get_weather>");
  });
});
