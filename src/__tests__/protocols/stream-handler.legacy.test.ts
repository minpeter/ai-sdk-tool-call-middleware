import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, test, vi } from "vitest";

import { jsonProtocol } from "../../core/protocols/json-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { mockUsage, stopFinishReason } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("jsonProtocol stream parsing", () => {
  const middleware = createToolMiddleware({
    protocol: jsonProtocol,
    toolSystemPromptTemplate: () => "",
  });

  const runMiddleware = (stream: ReadableStream<LanguageModelV3StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    if (!middleware.wrapStream) {
      throw new Error("wrapStream is not defined");
    }
    return middleware.wrapStream({
      doStream: mockDoStream,
      params: {},
    } as any);
  };

  test("should handle tool calls correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "<tool_call>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: '{"name": "get_weather", "arguments": {"location": "NY"}}',
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "</tool_call>",
        });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: mockUsage(1, 1),
        });
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);

    const chunks = await convertReadableStreamToArray(result.stream);

    const toolCallChunks = chunks.filter((c) => c.type === "tool-call");
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: '{"location":"NY"}',
    });

    const finish = chunks.find((c) => c.type === "finish") as
      | {
          type: "finish";
          finishReason: { unified: string; raw: string | undefined };
        }
      | undefined;
    expect(finish).toBeDefined();
    expect(finish?.finishReason).toEqual({
      unified: "tool-calls",
      raw: "stop",
    });
  });

  test("should handle malformed tool calls gracefully", async () => {
    const mockStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "<tool_call>invalid json</tool_call>",
        });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: mockUsage(1, 1),
        });
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);
    const chunks = await convertReadableStreamToArray(result.stream);

    const textContent = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(textContent).not.toContain("<tool_call>");
    expect(textContent).not.toContain("</tool_call>");

    const finish = chunks.find((c) => c.type === "finish") as
      | {
          type: "finish";
          finishReason: { unified: string; raw: string | undefined };
        }
      | undefined;
    expect(finish).toBeDefined();
    expect(finish?.finishReason).toEqual({
      unified: "stop",
      raw: undefined,
    });
  });
});
