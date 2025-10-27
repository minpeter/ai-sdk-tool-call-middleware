import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, test, vi } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";
import { createToolMiddleware } from "@/tool-call-middleware";
import { originalToolsSchema } from "@/utils/provider-options";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("morphXmlProtocol stream parsing", () => {
  const tools: LanguageModelV2FunctionTool[] = [
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

  const runMiddleware = (stream: ReadableStream<LanguageModelV2StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    return middleware.wrapStream!({
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
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
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
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);

    const chunks: LanguageModelV2StreamPart[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    const toolCallChunks = chunks.filter((c) => c.type === "tool-call");
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: '{"location":"San Fransisco"}',
    });
  });

  test("should handle argument-less XML tool calls correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
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
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);

    const chunks: LanguageModelV2StreamPart[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    const toolCallChunks = chunks.filter((c) => c.type === "tool-call");
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: "{}",
    });
  });
});
