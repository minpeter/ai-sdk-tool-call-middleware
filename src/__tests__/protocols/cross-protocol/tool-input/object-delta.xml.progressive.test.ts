import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  extractToolInputDeltas,
  findToolCall,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

const nestedTool: LanguageModelV3FunctionTool = {
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

const _weatherTool: LanguageModelV3FunctionTool = {
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

const permissiveObjectTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "shape_shift",
  description: "Permissive schema for streaming stability checks",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const _strictNameTool: LanguageModelV3FunctionTool = {
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

const mathSumTool: LanguageModelV3FunctionTool = {
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

const mathSumWithUnitTool: LanguageModelV3FunctionTool = {
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

describe("XML object-delta progressive invariants", () => {
  it("xml protocol emits parsed JSON deltas for nested object/array payloads", async () => {
    const chunks = [
      "<plan_trip>\n<location>Seo",
      "ul</location>\n<options><unit>ce",
      "lsius</unit><include_hourly>tru",
      "e</include_hourly></options>\n<days><item>mon</item><item>tue</item></days>\n",
      "</plan_trip>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [nestedTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((delta) => !delta.includes("<"))).toBe(true);
    expect(deltas.join("")).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Seoul",
      options: { unit: "celsius", include_hourly: "true" },
      days: ["mon", "tue"],
    });
  });

  it("xml protocol does not emit non-prefix string placeholders when nested tags are split across chunks", async () => {
    const chunks = [
      "<plan_trip>\n<location>Seoul</location>\n<options>",
      "<unit>celsius</unit></options>\n</plan_trip>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [nestedTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(deltas.some((delta) => delta.includes('"options":"'))).toBe(false);
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Seoul",
      options: { unit: "celsius" },
    });
  });

  it("xml protocol suppresses unstable single-root progress deltas for permissive schemas", async () => {
    const chunks = [
      "<shape_shift><person><name>Alice</name></person>",
      "<city>Seoul</city></shape_shift>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [permissiveObjectTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(joined.startsWith('"')).toBe(false);
    expect(joined.startsWith("{")).toBe(true);
    expect((deltas[0] ?? "").startsWith('{"name"')).toBe(false);
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      person: { name: "Alice" },
      city: "Seoul",
    });
  });

  it("xml protocol keeps delta stream prefix-safe when repeated tags later coerce to arrays", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [mathSumTool],
      chunks: [
        "<math_sum>\n<numbers>3</numbers>\n<numbers>5</numbers>\n<numbers>7</numbers>\n",
      ],
    });

    const toolCall = findToolCall(out);
    const deltas = extractToolInputDeltas(out);
    const joined = deltas.join("");

    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({ numbers: [3, 5, 7] });
    expect(deltas.some((delta) => delta.includes('"numbers":"'))).toBe(false);
  });

  it("xml protocol keeps deltas prefix-safe when array tags repeat after sibling top-level fields", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [mathSumWithUnitTool],
      chunks: [
        "<math_sum_with_unit>\n<numbers>3</numbers>\n<unit>celsius</unit>\n",
        "<numbers>5</numbers>\n</math_sum_with_unit>",
      ],
    });

    const toolCall = findToolCall(out);
    const deltas = extractToolInputDeltas(out);
    const joined = deltas.join("");

    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      numbers: [3, 5],
      unit: "celsius",
    });
    expect(deltas.some((delta) => delta.includes('"numbers":"'))).toBe(false);
  });

  it("xml protocol avoids scalar-to-array prefix mismatch deltas for permissive schemas", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol: morphXmlProtocol(),
      tools: [permissiveObjectTool],
      chunks: [
        "<shape_shift><numbers>3</numbers><unit>celsius</unit>",
        "<numbers>5</numbers></shape_shift>",
      ],
    });

    const toolCall = findToolCall(out);
    const deltas = extractToolInputDeltas(out);
    const joined = deltas.join("");

    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      numbers: ["3", "5"],
      unit: "celsius",
    });
    expect(deltas.some((delta) => delta.includes('"numbers":"3"'))).toBe(false);
  });
});
