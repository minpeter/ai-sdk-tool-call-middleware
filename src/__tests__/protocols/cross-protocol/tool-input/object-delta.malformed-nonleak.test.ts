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

function _extractToolInputDeltas(parts: LanguageModelV3StreamPart[]): string[] {
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

function _extractTextDeltas(parts: LanguageModelV3StreamPart[]): string {
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

function _findToolCall(
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
