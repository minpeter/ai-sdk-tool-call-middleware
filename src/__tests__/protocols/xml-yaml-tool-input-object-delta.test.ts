import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { xmlProtocol } from "../../core/protocols/xml-protocol";
import { yamlProtocol } from "../../core/protocols/yaml-protocol";
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
    const protocol = xmlProtocol();
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

  it("yaml protocol handles key-split chunks and still emits parsed JSON deltas", async () => {
    const protocol = yamlProtocol();
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

    expect(deltas).toEqual(['{"location":"Seoul', '","unit":"celsius', '"}']);
    expect(deltas.join("")).toBe(toolCall.input);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
  });

  it("yaml protocol avoids unstable null placeholder deltas for incomplete mapping lines", async () => {
    const protocol = yamlProtocol();
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

  it("xml/yaml finish reconciliation emits final suffix so joined deltas equal final tool input", async () => {
    const xmlTransformer = xmlProtocol().createStreamParser({
      tools: [weatherTool],
    });
    const yamlTransformer = yamlProtocol().createStreamParser({
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

  it("malformed xml/yaml do not leave dangling tool-input streams", async () => {
    const [xmlOut, yamlOut] = await Promise.all([
      convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream([
            "<get_weather><location>Seoul<location></get_weather>",
          ]),
          xmlProtocol().createStreamParser({ tools: [weatherTool] })
        )
      ),
      convertReadableStreamToArray(
        pipeWithTransformer(
          createTextDeltaStream([
            "<get_weather>\n- invalid\n- yaml\n</get_weather>",
          ]),
          yamlProtocol().createStreamParser({ tools: [weatherTool] })
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
});
