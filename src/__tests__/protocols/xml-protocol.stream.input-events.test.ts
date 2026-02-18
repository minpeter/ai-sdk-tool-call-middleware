import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

type ToolInputStartPart = Extract<
  LanguageModelV3StreamPart,
  { type: "tool-input-start" }
>;
type ToolInputEndPart = Extract<
  LanguageModelV3StreamPart,
  { type: "tool-input-end" }
>;
type ToolCallPart = Extract<LanguageModelV3StreamPart, { type: "tool-call" }>;

const tools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
];

function createTextDeltaStream(chunks: string[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id: "legacy-fixture",
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

function extract(parts: LanguageModelV3StreamPart[]) {
  const starts = parts.filter(
    (part) => part.type === "tool-input-start"
  ) as ToolInputStartPart[];
  const ends = parts.filter(
    (part) => part.type === "tool-input-end"
  ) as ToolInputEndPart[];
  const calls = parts.filter(
    (part) => part.type === "tool-call"
  ) as ToolCallPart[];
  return { starts, ends, calls };
}

describe("morphXmlProtocol legacy branch: tool-input events", () => {
  it("keeps tool-input lifecycle order as start -> end -> tool-call for XML", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "prefix ",
          "<get_weather>",
          "<location>NY</location>",
          "</get_weather>",
          " suffix",
        ]),
        transformer
      )
    );

    const { starts, ends, calls } = extract(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(starts[0]?.toolName).toBe("get_weather");
    expect(starts[0]?.id).toBe(ends[0]?.id);
    expect(starts[0]?.id).toBe(calls[0]?.toolCallId);
    expect(calls[0]?.input).toBe('{"location":"NY"}');

    const startIndex = out.findIndex(
      (part) => part.type === "tool-input-start"
    );
    const endIndex = out.findIndex((part) => part.type === "tool-input-end");
    const callIndex = out.findIndex((part) => part.type === "tool-call");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(callIndex).toBeGreaterThan(endIndex);
  });
});
