import { describe, test, expect, vi } from "vitest";
import {
  LanguageModelV2StreamPart,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { createToolMiddleware } from "@/tool-call-middleware";
import { xmlProtocol } from "@/protocols/xml-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("xmlProtocol stream parsing", () => {
  const tools: LanguageModelV2FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object" },
    },
  ];

  const middleware = createToolMiddleware({
    protocol: xmlProtocol,
    toolSystemPromptTemplate: () => "",
  });

  const runMiddleware = (stream: ReadableStream<LanguageModelV2StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    return middleware.wrapStream!({
      doStream: mockDoStream,
      params: { tools },
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

    const toolCallChunks = chunks.filter(c => c.type === "tool-call");
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

    const toolCallChunks = chunks.filter(c => c.type === "tool-call");
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: "{}",
    });
  });
});
