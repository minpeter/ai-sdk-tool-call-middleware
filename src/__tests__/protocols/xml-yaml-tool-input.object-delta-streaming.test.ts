import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

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

const permissiveObjectTool: LanguageModelV3FunctionTool = {
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

function createTextDeltaStream(chunks: string[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id: "fixture",
          delta: chunk,
        });
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function extractToolInputDeltas(parts: LanguageModelV3StreamPart[]): string[] {
  return parts
    .filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    )
    .map((part) => part.delta);
}

function extractTextDeltas(parts: LanguageModelV3StreamPart[]): string {
  return parts
    .filter(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
        part.type === "text-delta"
    )
    .map((part) => part.delta)
    .join("");
}

function findToolCall(
  parts: LanguageModelV3StreamPart[]
): Extract<LanguageModelV3StreamPart, { type: "tool-call" }> {
  const toolCall = parts.find(
    (part): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
      part.type === "tool-call"
  );
  if (!toolCall) {
    throw new Error("Expected tool-call part");
  }
  return toolCall;
}

describe("XML/YAML object delta streaming", () => {
  it("xml protocol emits parsed JSON deltas for nested object/array payloads", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [nestedTool] });
    const chunks = [
      "<plan_trip>\n<location>Seo",
      "ul</location>\n<options><unit>ce",
      "lsius</unit><include_hourly>tru",
      "e</include_hourly></options>\n<days><item>mon</item><item>tue</item></days>\n",
      "</plan_trip>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [nestedTool] });
    const chunks = [
      "<plan_trip>\n<location>Seoul</location>\n<options>",
      "<unit>celsius</unit></options>\n</plan_trip>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: [permissiveObjectTool],
    });
    const chunks = [
      "<shape_shift><person><name>Alice</name></person>",
      "<city>Seoul</city></shape_shift>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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

  it("yaml protocol handles key-split chunks and still emits parsed JSON deltas", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [weatherTool] });
    const chunks = [
      "<get_weather>",
      "\n",
      "location: Seoul\nu",
      "nit: celsius\n",
      "</get_weather>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);

    expect(deltas).toEqual(['{"location":"Seoul","unit":"celsius', '"}']);
    expect(deltas.join("")).toBe(toolCall.input);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
  });

  it("yaml protocol avoids unstable null placeholder deltas for incomplete mapping lines", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [weatherTool] });
    const chunks = [
      "<get_weather>\nlocation:\n",
      "  Seoul\nunit: celsius\n",
      "</get_weather>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

    const deltas = extractToolInputDeltas(out);
    const toolCall = findToolCall(out);
    const joined = deltas.join("");

    expect(joined).toBe(toolCall.input);
    expect(joined).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.some((delta) => delta.includes("null"))).toBe(false);
  });

  it("yaml protocol treats split scalar tokens as unstable until the scalar is complete", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [nestedTool] });
    const chunks = ["<plan_trip>\nk0_1: t", "rue\nk0_2: done\n</plan_trip>"];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [nestedTool] });
    const chunks = [
      "<plan_trip>\nlocation: Seoul\noptions:\n  u",
      "nit: celsius\n</plan_trip>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [nestedTool] });
    const chunks = [
      "<plan_trip>\nlocation: Seoul\ndays:\n  -",
      " mon\n  - tue\n",
      "</plan_trip>",
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: [writeMarkdownTool],
    });
    const chunks = [
      "<write_markdown_file>\nfile_path: stream-tool-input-visual-demo.md\ncontent: |\n #",
      " Stream",
      " Tool",
      " Visual",
      " Demo",
      "\n paragraph line\n",
      "</write_markdown_file>",
    ];

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream(chunks), transformer)
    );

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

  it("xml/yaml finish reconciliation emits final suffix so joined deltas equal final tool input", async () => {
    const xmlTransformer = morphXmlProtocol().createStreamParser({
      tools: [weatherTool],
    });
    const yamlTransformer = yamlXmlProtocol().createStreamParser({
      tools: [weatherTool],
    });

    const [xmlOut, yamlOut] = await Promise.all([
      convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream([
            "<get_weather>\n<location>Bus",
            "an</location>\n<unit>celsius</unit>\n",
          ]),
          xmlTransformer
        )
      ),
      convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream([
            "<get_weather>\nlocation: Busan\nunit: celsius\n",
          ]),
          yamlTransformer
        )
      ),
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

  it("xml protocol keeps delta stream prefix-safe when repeated tags later coerce to arrays", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<math_sum>\n<numbers>3</numbers>\n<numbers>5</numbers>\n<numbers>7</numbers>\n",
        ]),
        morphXmlProtocol().createStreamParser({
          tools: [mathSumTool],
        })
      )
    );

    const toolCall = findToolCall(out);
    const deltas = extractToolInputDeltas(out);
    const joined = deltas.join("");

    expect(joined).toBe(toolCall.input);
    expect(JSON.parse(toolCall.input)).toEqual({ numbers: [3, 5, 7] });
    expect(deltas.some((delta) => delta.includes('"numbers":"'))).toBe(false);
  });

  it("xml protocol keeps deltas prefix-safe when array tags repeat after sibling top-level fields", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<math_sum_with_unit>\n<numbers>3</numbers>\n<unit>celsius</unit>\n",
          "<numbers>5</numbers>\n</math_sum_with_unit>",
        ]),
        morphXmlProtocol().createStreamParser({
          tools: [mathSumWithUnitTool],
        })
      )
    );

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
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<shape_shift><numbers>3</numbers><unit>celsius</unit>",
          "<numbers>5</numbers></shape_shift>",
        ]),
        morphXmlProtocol().createStreamParser({
          tools: [permissiveObjectTool],
        })
      )
    );

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

  it("malformed xml/yaml do not leave dangling tool-input streams", async () => {
    const [xmlOut, yamlOut] = await Promise.all([
      convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream([
            "<get_weather><location>Seoul<location></get_weather>",
          ]),
          morphXmlProtocol().createStreamParser({ tools: [weatherTool] })
        )
      ),
      convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream([
            "<get_weather>\n- invalid\n- yaml\n</get_weather>",
          ]),
          yamlXmlProtocol().createStreamParser({ tools: [weatherTool] })
        )
      ),
    ]);

    const xmlStarts = xmlOut.filter((part) => part.type === "tool-input-start");
    const xmlEnds = xmlOut.filter((part) => part.type === "tool-input-end");
    const yamlStarts = yamlOut.filter(
      (part) => part.type === "tool-input-start"
    );
    const yamlEnds = yamlOut.filter((part) => part.type === "tool-input-end");

    expect(xmlStarts.length).toBe(xmlEnds.length);
    expect(yamlStarts.length).toBe(yamlEnds.length);
    expect(xmlOut.some((part) => part.type === "finish")).toBe(true);
    expect(yamlOut.some((part) => part.type === "finish")).toBe(true);
  });

  it("xml finish on unclosed malformed tool call closes stream without raw fallback by default", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<bad_tool><name>first</name><name>second</name>",
        ]),
        morphXmlProtocol().createStreamParser({
          tools: [strictNameTool],
        })
      )
    );

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).not.toContain("<bad_tool>");
  });

  it("xml finish on unclosed malformed tool call can emit raw fallback when enabled", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<bad_tool><name>first</name><name>second</name>",
        ]),
        morphXmlProtocol().createStreamParser({
          tools: [strictNameTool],
          options: { emitRawToolCallTextOnError: true },
        })
      )
    );

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).toContain("<bad_tool>");
    expect(text).toContain("<name>first</name>");
  });

  it("yaml progress parse with single-line malformed body emits no unstable deltas and no tool-call", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<get_weather>\n["]),
        yamlXmlProtocol().createStreamParser({
          tools: [weatherTool],
        })
      )
    );

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

  it("yaml finish on malformed unclosed tool call can emit raw fallback when enabled", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<get_weather>\n["]),
        yamlXmlProtocol().createStreamParser({
          tools: [weatherTool],
          options: { emitRawToolCallTextOnError: true },
        })
      )
    );

    const starts = out.filter((part) => part.type === "tool-input-start");
    const ends = out.filter((part) => part.type === "tool-input-end");
    const text = extractTextDeltas(out);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(text).toContain("<get_weather>");
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
      const out = await convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream(["<get_weather>\nlocation: Seoul\nunit:\n"]),
          yamlXmlProtocol().createStreamParser({
            tools: [weatherTool],
          })
        )
      );

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
