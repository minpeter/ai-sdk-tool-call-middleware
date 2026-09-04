import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { observeObjectDeltas } from "../../shared/duplicate-harness";

const nestedTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "plan_trip",
  description: "Build travel plan payload",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "array",
        items: { type: "string" },
      },
      location: { type: "string" },
      options: {
        type: "object",
        properties: {
          include_hourly: { type: "string" },
          unit: { type: "string" },
        },
      },
    },
    required: ["location"],
  },
};

const permissiveObjectTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "shape_shift",
  description: "Permissive schema for streaming stability checks",
  inputSchema: {
    type: "object",
  },
};

const mathSumTool: LanguageModelV4FunctionTool = {
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

const mathSumWithUnitTool: LanguageModelV4FunctionTool = {
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

async function observeXml(
  chunks: readonly string[],
  tool: LanguageModelV4FunctionTool
) {
  const observation = await observeObjectDeltas({
    chunks,
    id: `xml-object-delta-${tool.name}`,
    protocol: morphXmlProtocol(),
    tools: [tool],
  });
  return {
    ...observation,
    deltas: observation.timeline.deltas.map((part) => part.delta),
    joined: observation.joinedInput,
  };
}

describe("XML object-delta progressive invariants", () => {
  it("xml protocol emits parsed JSON deltas for nested object/array payloads", async () => {
    const chunks = [
      "<plan_trip>\n<location>Seo",
      "ul</location>\n<options><unit>ce",
      "lsius</unit><include_hourly>tru",
      "e</include_hourly></options>\n<days><item>mon</item><item>tue</item></days>\n",
      "</plan_trip>",
    ];
    const { timeline, toolCall } = await observeXml(chunks, nestedTool);
    const deltas = timeline.deltas.map((part) => part.delta);

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
    const { deltas, joined, toolCall } = await observeXml(chunks, nestedTool);
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
    const { deltas, joined, toolCall } = await observeXml(
      chunks,
      permissiveObjectTool
    );
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
    const { deltas, joined, toolCall } = await observeXml(
      [
        "<math_sum>\n<numbers>3</numbers>\n<numbers>5</numbers>\n<numbers>7</numbers>\n",
      ],
      mathSumTool
    );
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({ numbers: [3, 5, 7] });
    expect(deltas.some((delta) => delta.includes('"numbers":"'))).toBe(false);
  });

  it("xml protocol keeps deltas prefix-safe when array tags repeat after sibling top-level fields", async () => {
    const { deltas, joined, toolCall } = await observeXml(
      [
        "<math_sum_with_unit>\n<numbers>3</numbers>\n<unit>celsius</unit>\n",
        "<numbers>5</numbers>\n</math_sum_with_unit>",
      ],
      mathSumWithUnitTool
    );
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      numbers: [3, 5],
      unit: "celsius",
    });
    expect(deltas.some((delta) => delta.includes('"numbers":"'))).toBe(false);
  });

  it("xml protocol avoids scalar-to-array prefix mismatch deltas for permissive schemas", async () => {
    const { deltas, joined, toolCall } = await observeXml(
      [
        "<shape_shift><numbers>3</numbers><unit>celsius</unit>",
        "<numbers>5</numbers></shape_shift>",
      ],
      permissiveObjectTool
    );
    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({
      numbers: ["3", "5"],
      unit: "celsius",
    });
    expect(deltas.some((delta) => delta.includes('"numbers":"3"'))).toBe(false);
  });
});
