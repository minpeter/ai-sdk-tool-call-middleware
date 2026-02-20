import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  extractTextDeltas,
  extractToolInputDeltas,
  findToolCall,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

const _nestedTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "plan_trip",
  description: "Build travel plan payload",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      options: {
        type: "object",
        properties: {
          unit: { type: "string" },
          include_hourly: { type: "string" },
        },
      },
      days: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["location"],
  },
};

const weatherTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string" },
    },
    required: ["location"],
  },
};

const _permissiveObjectTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "shape_shift",
  description: "Permissive schema for streaming stability checks",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const strictNameTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "bad_tool",
  description: "Strict tool for malformed stream edge tests",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
};

const _writeMarkdownTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "write_markdown_file",
  description: "Write markdown file",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
  },
};

const _mathSumTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "math_sum",
  description: "Sum numbers",
  inputSchema: {
    type: "object",
    properties: {
      numbers: {
        type: "array",
        items: { type: "number" },
      },
    },
    required: ["numbers"],
  },
};

const _mathSumWithUnitTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "math_sum_with_unit",
  description: "Sum numbers with unit",
  inputSchema: {
    type: "object",
    properties: {
      numbers: {
        type: "array",
        items: { type: "number" },
      },
      unit: { type: "string" },
    },
    required: ["numbers", "unit"],
  },
};

describe("XML/YAML finish reconciliation policy", () => {
  it("xml/yaml finish reconciliation emits final suffix so joined deltas equal final tool input", async () => {
    const [xmlOut, yamlOut] = await Promise.all([
      runProtocolTextDeltaStream({
        protocol: morphXmlProtocol(),
        tools: [weatherTool],
        chunks: [
          "<get_weather>\n<location>Bus",
          "an</location>\n<unit>celsius</unit>\n",
        ],
      }),
      runProtocolTextDeltaStream({
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather>\nlocation: Busan\nunit: celsius\n"],
      }),
    ]);

    const xmlCall = findToolCall(xmlOut);
    const yamlCall = findToolCall(yamlOut);
    const xmlJoined = extractToolInputDeltas(xmlOut).join("");
    const yamlJoined = extractToolInputDeltas(yamlOut).join("");

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
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [strictNameTool],
      chunks: ["<bad_tool><name>first</name><name>second</name>"],
    });

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).not.toContain("<bad_tool>");
  });

  it("xml finish on unclosed malformed tool call can emit raw fallback when enabled", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [strictNameTool],
      chunks: ["<bad_tool><name>first</name><name>second</name>"],
      options: { emitRawToolCallTextOnError: true },
    });

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).toContain("<bad_tool>");
    expect(text).toContain("<name>first</name>");
  });

  it("yaml finish on malformed unclosed tool call can emit raw fallback when enabled", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
      chunks: ["<get_weather>\n["],
      options: { emitRawToolCallTextOnError: true },
    });

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).toContain("<get_weather>");
  });
});
