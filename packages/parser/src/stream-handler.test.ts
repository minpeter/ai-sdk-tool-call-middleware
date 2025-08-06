import { describe, test, expect, vi } from "vitest";
import { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { normalToolStream } from "./stream-handler";

// Mock generateId function 
vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const TEST_TAGS = {
  toolCallTag: "<TOOL_CALL>",
  toolCallEndTag: "</TOOL_CALL>",
};

describe("normalToolStream", () => {
  test("should emit text-start, text-delta, and text-end for regular text", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "Hello world",
        });
        controller.enqueue({
          type: "finish",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: "stop",
        });
        controller.close();
      },
    });

    const mockDoStream = vi.fn().mockResolvedValue({
      stream: mockStream,
      request: {},
      response: {},
    });

    const result = await normalToolStream({
      doStream: mockDoStream,
      ...TEST_TAGS,
    });

    const chunks: LanguageModelV2StreamPart[] = [];
    const reader = result.stream.getReader();
    
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        chunks.push(value);
      }
    }

    // Should emit start, delta, end, and finish
    expect(chunks).toHaveLength(4);
    
    // Check text-start chunk
    expect(chunks[0]).toEqual({
      type: "text-start",
      id: "mock-id",
    });

    // Check text-delta chunk
    expect(chunks[1]).toEqual({
      type: "text-delta",
      id: "mock-id",
      delta: "Hello world",
    });

    // Check text-end chunk
    expect(chunks[2]).toEqual({
      type: "text-end",
      id: "mock-id",
    });

    // Check finish chunk
    expect(chunks[3]).toEqual({
      type: "finish",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop",
    });
  });

  test("should handle tool calls correctly without affecting start/delta/end pattern", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "I need to call a tool ",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "<TOOL_CALL>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: '{"name": "get_weather", "arguments": {"location": "NY"}}',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "</TOOL_CALL>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: " done",
        });
        controller.enqueue({
          type: "finish",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          finishReason: "tool-calls",
        });
        controller.close();
      },
    });

    const mockDoStream = vi.fn().mockResolvedValue({
      stream: mockStream,
      request: {},
      response: {},
    });

    const result = await normalToolStream({
      doStream: mockDoStream,
      ...TEST_TAGS,
    });

    const chunks: LanguageModelV2StreamPart[] = [];
    const reader = result.stream.getReader();
    
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        chunks.push(value);
      }
    }

    // Find text and tool-call chunks
    const textStartChunks = chunks.filter(c => c.type === "text-start");
    const textDeltaChunks = chunks.filter(c => c.type === "text-delta");
    const textEndChunks = chunks.filter(c => c.type === "text-end");
    const toolCallChunks = chunks.filter(c => c.type === "tool-call");

    // Should have proper text start/delta/end pattern
    expect(textStartChunks).toHaveLength(2); // Before and after tool call
    expect(textEndChunks).toHaveLength(2);
    expect(toolCallChunks).toHaveLength(1);
    
    // Check tool call content
    expect(toolCallChunks[0]).toEqual({
      type: "tool-call",
      toolCallId: "mock-id",
      toolName: "get_weather", 
      input: '{"location":"NY"}',
    });
  });
});