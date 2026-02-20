import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  extractTextDeltas,
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

const writeMarkdownTool: LanguageModelV3FunctionTool = {
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

describe("YAML object-delta progressive invariants", () => {
  it("yaml protocol handles key-split chunks and still emits parsed JSON deltas", async () => {
    const chunks = [
      "<get_weather>",
      "\n",
      "location: Seoul\nu",
      "nit: celsius\n",
      "</get_weather>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);

    expect(deltas).toEqual(['{"location":"Seoul","unit":"celsius', '"}']);
    expect(deltas.join("")).toBe(toolCall.input);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
  });

  it("yaml protocol avoids unstable null placeholder deltas for incomplete mapping lines", async () => {
    const chunks = [
      "<get_weather>\nlocation:\n",
      "  Seoul\nunit: celsius\n",
      "</get_weather>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(joined).toBe(toolCall.input);
    expect(joined).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.some((delta) => delta.includes("null"))).toBe(false);
  });

  it("yaml protocol treats split scalar tokens as unstable until the scalar is complete", async () => {
    const chunks = ["<plan_trip>\nk0_1: t", "rue\nk0_2: done\n</plan_trip>"];
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [nestedTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(deltas.some((delta) => delta.includes('"k0_1":"t'))).toBe(false);
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      k0_1: true,
      k0_2: "done",
    });
  });

  it("yaml protocol avoids emitting transient nested scalar placeholders from split nested keys", async () => {
    const chunks = [
      "<plan_trip>\nlocation: Seoul\noptions:\n  u",
      "nit: celsius\n</plan_trip>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
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

  it("yaml protocol avoids emitting transient null array items when a list item is split", async () => {
    const chunks = [
      "<plan_trip>\nlocation: Seoul\ndays:\n  -",
      " mon\n  - tue\n",
      "</plan_trip>",
    ];
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [nestedTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(deltas.some((delta) => delta.includes("[null"))).toBe(false);
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Seoul",
      days: ["mon", "tue"],
    });
  });

  it("yaml protocol keeps block-scalar progress deltas prefix-safe while a heading line is still streaming", async () => {
    const chunks = [
      "<write_markdown_file>\nfile_path: stream-tool-input-visual-demo.md\ncontent: |\n #",
      " Stream",
      " Tool",
      " Visual",
      " Demo",
      "\n paragraph line\n",
      "</write_markdown_file>",
    ];

    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [writeMarkdownTool],
      chunks,
    });

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(toolCall.input).toBe(
      JSON.stringify({
        file_path: "stream-tool-input-visual-demo.md",
        content: "# Stream Tool Visual Demo\nparagraph line\n",
      })
    );
    expect(joined).toBe(toolCall.input);
    expect(joined).toContain("Stream Tool Visual Demo");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("yaml progress parse with single-line malformed body emits no unstable deltas and no tool-call", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
      chunks: ["<get_weather>\n["],
    });

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const deltas = extractToolInputDeltas(out);
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(deltas).toHaveLength(0);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).not.toContain("<get_weather>");
  });

  it("yaml progress incomplete-tail branch suppresses deltas when truncated reparse fails", async () => {
    const parseSpy = vi.spyOn(YAML, "parseDocument");
    let calls = 0;
    parseSpy.mockImplementation(
      () =>
        ({
          errors:
            ++calls === 1 || calls === 3
              ? []
              : [{ message: "mock reparsing/final parse failure" }],
          toJSON: () => ({ location: "Seoul", unit: null }),
        }) as unknown as ReturnType<typeof YAML.parseDocument>
    );

    try {
      const out = await runProtocolTextDeltaStream({
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather>\nlocation: Seoul\nunit:\n"],
      });

      const starts = out.filter((part) => part.type === "tool-input-start");
      const ends = out.filter((part) => part.type === "tool-input-end");
      const deltas = extractToolInputDeltas(out);
      const text = extractTextDeltas(out);

      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(deltas).toHaveLength(0);
      expect(out.some((part) => part.type === "tool-call")).toBe(false);
      expect(text).not.toContain("<get_weather>");
      expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      parseSpy.mockRestore();
    }
  });
});
