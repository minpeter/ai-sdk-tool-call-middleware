import { describe, test, expect, vi } from "vitest";
import { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { createToolMiddleware } from "@/tool-call-middleware";
import { dummyProtocol } from "@/protocols/dummy-protocol";

describe("AI SDK v5 stream protocol compliance", () => {
  const middleware = createToolMiddleware({
    protocol: dummyProtocol,
    toolSystemPromptTemplate: () => "",
  });

  const runMiddleware = (stream: ReadableStream<LanguageModelV2StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    return middleware.wrapStream!({
      doStream: mockDoStream,
      params: {},
    } as any);
  };

  test("should produce compliant start/delta/end pattern for text", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "Hello world" } as any);
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as any);
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);
    const chunks: LanguageModelV2StreamPart[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].type).toBe("text-start");
    const id = (chunks[0] as any).id;
    expect(chunks[1]).toEqual({ type: "text-delta", id, delta: "Hello world" });
    expect(chunks[2]).toEqual({ type: "text-end", id });
  });

  test("handles empty text chunks correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "" } as any);
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as any);
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);
    const chunks: LanguageModelV2StreamPart[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter(
      c =>
        c.type === "text-delta" ||
        c.type === "text-start" ||
        c.type === "text-end"
    );
    expect(textChunks).toHaveLength(0);
    expect(chunks.find(c => c.type === "finish")).toBeDefined();
  });
});
