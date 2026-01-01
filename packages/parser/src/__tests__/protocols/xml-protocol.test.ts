import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, test, vi } from "vitest";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../v6/tool-call-middleware";
import { mockUsage, stopFinishReason } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("morphXmlProtocol stream parsing", () => {
  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object" },
    },
  ];

  const middleware = createToolMiddleware({
    protocol: morphXmlProtocol,
    toolSystemPromptTemplate: () => "",
  });

  const runMiddleware = (stream: ReadableStream<LanguageModelV3StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    return middleware.wrapStream?.({
      doStream: mockDoStream,
      params: {
        tools,
        providerOptions: {
          // INFO: Since this test does not go through the transform handler
          // that normally injects this, we need to provide it manually.
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    } as any);
  };

  test("should handle standard XML tool calls correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "<get_wea",
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "ther>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "<location>San Fransisco</location>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "</get_",
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "weather>",
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

    expect(result).toBeDefined();
    if (!result) {
      throw new Error("result is undefined");
    }
    const chunks = await convertReadableStreamToArray(result.stream);

    const toolCallChunks = chunks.filter((c) => c.type === "tool-call");
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: '{"location":"San Fransisco"}',
    });
  });

  test("should handle argument-less XML tool calls correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "<get_weather>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "</get_weather>",
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

    expect(result).toBeDefined();
    if (!result) {
      throw new Error("result is undefined");
    }
    const chunks = await convertReadableStreamToArray(result.stream);

    const toolCallChunks = chunks.filter((c) => c.type === "tool-call");
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: "{}",
    });
  });
});
