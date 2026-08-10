import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { kExaone2Protocol } from "../../../core/protocols/k-exaone-2-protocol";
import { createChunkedStream, pipeWithTransformer } from "../../test-helpers";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
  },
];

describe("kExaone2Protocol stream reasoning contract", () => {
  it("passes provider-native reasoning events through unchanged", async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: "reasoning-start", id: "reasoning-1" },
      {
        type: "reasoning-delta",
        id: "reasoning-1",
        delta: "Need weather data.",
      },
      { type: "reasoning-end", id: "reasoning-1" },
    ];
    const input = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

    const output = await convertReadableStreamToArray(
      pipeWithTransformer(
        input,
        kExaone2Protocol().createStreamParser({ tools })
      )
    );

    expect(output).toEqual(parts);
  });

  it("preserves literal think markup inside streamed tool arguments", async () => {
    const text =
      "<tool_call><function=echo><parameter=text>literal <think>not reasoning</think> payload</parameter></function></tool_call>";
    const output = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(text),
        kExaone2Protocol().createStreamParser({ tools })
      )
    );
    const call = output.find((part) => part.type === "tool-call");

    expect(call?.type).toBe("tool-call");
    expect(JSON.parse(call?.type === "tool-call" ? call.input : "{}")).toEqual({
      text: "literal <think>not reasoning</think> payload",
    });
  });
});
