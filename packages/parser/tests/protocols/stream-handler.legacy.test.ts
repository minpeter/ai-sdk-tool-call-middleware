import { describe, test, expect, vi } from "vitest";
import { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { createToolMiddleware } from "@/tool-call-middleware";
import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("jsonMixProtocol stream parsing", () => {
  const middleware = createToolMiddleware({
    protocol: jsonMixProtocol,
    toolSystemPromptTemplate: () => "",
  });

  const runMiddleware = (stream: ReadableStream<LanguageModelV2StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    return middleware.wrapStream!({
      doStream: mockDoStream,
      params: {},
    } as any);
  };

  test("should handle tool calls correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
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
      input: '{"location":"NY"}',
    });
  });

  test("should handle malformed tool calls gracefully", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
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

    const textContent = chunks
      .filter(c => c.type === "text-delta")
      .map(c => (c as any).delta)
      .join("");
    expect(textContent).toContain("<tool_call>invalid json</tool_call>");
  });
});
