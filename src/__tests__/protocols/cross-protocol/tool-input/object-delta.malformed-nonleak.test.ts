import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

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

describe("XML/YAML malformed non-leak guarantees", () => {
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
});
