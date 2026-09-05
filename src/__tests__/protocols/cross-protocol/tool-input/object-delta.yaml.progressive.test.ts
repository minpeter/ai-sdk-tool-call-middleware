import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  collectTextDeltas,
  observeObjectDeltas,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const nestedTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "plan_trip",
  description: "Build travel plan payload",
  inputSchema: {
    type: "object",
    properties: {
      k0_1: { type: "boolean" },
      k0_2: { type: "string" },
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

const weatherTool: LanguageModelV4FunctionTool = {
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

const writeMarkdownTool: LanguageModelV4FunctionTool = {
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

async function observeYaml(
  chunks: readonly string[],
  tool: LanguageModelV4FunctionTool = nestedTool
) {
  const observation = await observeObjectDeltas({
    chunks,
    id: `yaml-object-delta-${tool.name}`,
    protocol: yamlXmlProtocol(),
    tools: [tool],
  });
  return {
    ...observation,
    deltas: observation.timeline.deltas.map((part) => part.delta),
    joined: observation.joinedInput,
  };
}

function expectSuppressed(
  out: Awaited<ReturnType<typeof runProtocolTextStream>>
): void {
  const { starts, deltas, ends } = selectToolInputTimeline(out);
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(deltas).toHaveLength(0);
  expect(out.some((part) => part.type === "tool-call")).toBe(false);
  expect(collectTextDeltas(out)).not.toContain("<get_weather>");
}

describe("YAML object-delta progressive invariants", () => {
  it("yaml protocol handles key-split chunks and still emits parsed JSON deltas", async () => {
    const chunks = [
      "<get_weather>",
      "\n",
      "location: Seoul\nu",
      "nit: celsius\n",
      "</get_weather>",
    ];
    const { timeline, toolCall } = await observeYaml(chunks, weatherTool);
    const deltas = timeline.deltas.map((part) => part.delta);

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
    const { deltas, joined, toolCall } = await observeYaml(chunks, weatherTool);
    expect(joined).toBe(toolCall.input);
    expect(joined).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.some((delta) => delta.includes("null"))).toBe(false);
  });

  it("yaml protocol treats split scalar tokens as unstable until the scalar is complete", async () => {
    const chunks = ["<plan_trip>\nk0_1: t", "rue\nk0_2: done\n</plan_trip>"];
    const { deltas, joined, toolCall } = await observeYaml(chunks);
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
    const { deltas, joined, toolCall } = await observeYaml(chunks);
    expect(deltas.some((delta) => delta.includes('"options":"'))).toBe(false);
    expect(joined).toBe(toolCall.input);
    expect(toolCall.input).toBe(
      JSON.stringify({ location: "Seoul", options: { unit: "celsius" } })
    );
  });

  it("yaml protocol avoids emitting transient null array items when a list item is split", async () => {
    const chunks = [
      "<plan_trip>\nlocation: Seoul\ndays:\n  -",
      " mon\n  - tue\n",
      "</plan_trip>",
    ];
    const { deltas, joined, toolCall } = await observeYaml(chunks);
    expect(deltas.some((delta) => delta.includes("[null"))).toBe(false);
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Seoul",
      days: ["mon", "tue"],
    });
  });

  it("yaml protocol buffers block scalars whose indentation and chomping are not prefix-stable", async () => {
    const chunks = [
      "<write_markdown_file>\nfile_path: stream-tool-input-visual-demo.md\ncontent: |\n #",
      " Stream",
      " Tool",
      " Visual",
      " Demo",
      "\n paragraph line\n",
      "</write_markdown_file>",
    ];

    const { deltas, joined, toolCall } = await observeYaml(
      chunks,
      writeMarkdownTool
    );
    expect(toolCall.input).toBe(
      JSON.stringify({
        file_path: "stream-tool-input-visual-demo.md",
        content: "# Stream Tool Visual Demo\nparagraph line\n",
      })
    );
    expect(joined).toBe(toolCall.input);
    expect(joined).toContain("Stream Tool Visual Demo");
    expect(deltas).toEqual([toolCall.input]);
  });

  it("yaml progress parse with single-line malformed body emits no unstable deltas and no tool-call", async () => {
    const out = await runProtocolTextStream({
      chunks: ["<get_weather>\n["],
      id: "yaml-malformed-progress",
      protocol: yamlXmlProtocol(),
      tools: [weatherTool],
    });

    expectSuppressed(out);
  });

  it("yaml progress incomplete-tail branch suppresses deltas when truncated reparse fails", async () => {
    const { parseDocument } = YAML;
    const parseSpy = vi.spyOn(YAML, "parseDocument");
    let calls = 0;
    parseSpy.mockImplementation((source, options) => {
      calls += 1;
      const document = parseDocument(source, options);
      if (calls !== 1 && calls !== 3) {
        document.errors = parseDocument("[").errors;
      }
      return document;
    });

    try {
      // A schema without properties keeps the schema-keyed raw-string salvage
      // out of the picture, so the mocked final-parse failure stays a failure.
      const out = await runProtocolTextStream({
        chunks: ["<get_weather>\nlocation: Seoul\nunit:\n"],
        id: "yaml-truncated-reparse",
        protocol: yamlXmlProtocol(),
        tools: [{ ...weatherTool, inputSchema: { type: "object" } }],
      });

      expectSuppressed(out);
      expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      parseSpy.mockRestore();
    }
  });
});
