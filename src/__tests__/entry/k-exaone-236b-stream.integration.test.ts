import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";
import {
  mockUsage,
  requireTransformParams,
  stopFinishReason,
} from "../test-helpers";

describe("kExaone236BToolMiddleware stream", () => {
  it("parses a chunked Hermes call through the public preset", async () => {
    const transformParams = requireTransformParams(
      kExaone236BToolMiddleware.transformParams
    );
    const transformed = await transformParams({
      type: "stream",
      model: {} as never,
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "Probe." }] }],
        tools: [
          {
            type: "function",
            name: "edge_probe",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
        ],
      },
    });
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "reasoning-start", id: "reasoning-1" });
        controller.enqueue({
          type: "reasoning-delta",
          id: "reasoning-1",
          delta: "Inspecting.",
        });
        controller.enqueue({ type: "reasoning-end", id: "reasoning-1" });
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: '<tool_call>{"name":"edge_',
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: 'probe","arguments":{"value":1}}</tool_call>',
        });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: mockUsage(2, 3),
        });
        controller.close();
      },
    });
    if (!kExaone236BToolMiddleware.wrapStream) {
      throw new Error("wrapStream is not defined");
    }

    const result = await kExaone236BToolMiddleware.wrapStream({
      doGenerate: () => {
        throw new Error("doGenerate should not be called for auto tool choice");
      },
      doStream: () => Promise.resolve({ stream: source }),
      params: transformed,
      model: {} as never,
    });
    const parts = await convertReadableStreamToArray(result.stream);

    expect(parts).toEqual(
      expect.arrayContaining([
        { type: "reasoning-start", id: "reasoning-1" },
        {
          type: "reasoning-delta",
          id: "reasoning-1",
          delta: "Inspecting.",
        },
        { type: "reasoning-end", id: "reasoning-1" },
        expect.objectContaining({
          type: "tool-call",
          toolName: "edge_probe",
          input: '{"value":1}',
        }),
        expect.objectContaining({
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "stop" },
        }),
      ])
    );
    const toolCall = parts.find((part) => part.type === "tool-call");
    const start = parts.find((part) => part.type === "tool-input-start");
    const end = parts.find((part) => part.type === "tool-input-end");
    expect(start?.id).toBe(toolCall?.toolCallId);
    expect(end?.id).toBe(toolCall?.toolCallId);
  });
});
