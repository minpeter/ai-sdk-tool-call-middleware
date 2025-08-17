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
    const textStartChunks = chunks.filter((c) => c.type === "text-start");
    const textDeltaChunks = chunks.filter((c) => c.type === "text-delta");
    const textEndChunks = chunks.filter((c) => c.type === "text-end");
    const toolCallChunks = chunks.filter((c) => c.type === "tool-call");

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

  test("should handle multiple tool calls in sequence", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "<TOOL_CALL>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: '{"name": "tool1", "arguments": {}}',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "</TOOL_CALL><TOOL_CALL>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: '{"name": "tool2", "arguments": {"key": "value"}}',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "</TOOL_CALL>",
        });
        controller.enqueue({
          type: "finish",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
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

    const toolCallChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "tool-call" }> =>
        c.type === "tool-call"
    );
    expect(toolCallChunks).toHaveLength(2);
    expect(toolCallChunks[0].toolName).toBe("tool1");
    expect(toolCallChunks[1].toolName).toBe("tool2");
  });

  test("should handle partial tool call tags across chunks", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "Text before <TOOL",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "_CALL>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: '{"name": "test"',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: ', "arguments": {}}',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "</TOOL",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "_CALL> after",
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

    const toolCallChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "tool-call" }> =>
        c.type === "tool-call"
    );
    const textDeltaChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
        c.type === "text-delta"
    );

    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0].toolName).toBe("test");

    // Should have text before and after
    const textContent = textDeltaChunks.map((c) => c.delta).join("");
    expect(textContent).toContain("Text before");
    expect(textContent).toContain("after");
  });

  test("should handle malformed tool calls gracefully", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "<TOOL_CALL>invalid json</TOOL_CALL>",
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

    // Should pass through as text when JSON parsing fails
    const textDeltaChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
        c.type === "text-delta"
    );
    const textContent = textDeltaChunks.map((c) => c.delta).join("");
    expect(textContent).toContain("<TOOL_CALL>invalid json</TOOL_CALL>");
  });

  test("should handle empty tool calls", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "<TOOL_CALL></TOOL_CALL>",
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

    // Empty tool call should be passed as text
    const textDeltaChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
        c.type === "text-delta"
    );
    const textContent = textDeltaChunks.map((c) => c.delta).join("");
    expect(textContent).toContain("<TOOL_CALL></TOOL_CALL>");
  });

  test("should pass through non-text-delta chunks unchanged", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "error",
          error: new Error("Test error"),
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

    // Should have error and finish chunks
    const errorChunks = chunks.filter((c) => c.type === "error");
    const finishChunks = chunks.filter((c) => c.type === "finish");

    expect(errorChunks).toHaveLength(1);
    expect(finishChunks).toHaveLength(1);
  });

  test("should handle incomplete tool call at stream end", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "Text before <TOOL_CALL>\n",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "{'name': 'cnbc_news_",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "feed', 'arguments': {}}",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "\n</TOOL_",
        });
        // Stream ends without closing the tool call
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

    // Incomplete tool call should be passed as text
    const textDeltaChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
        c.type === "text-delta"
    );
    const textContent = textDeltaChunks.map((c) => c.delta).join("");

    expect(textContent).toEqual(
      "Text before <TOOL_CALL>\n{'name': 'cnbc_news_feed', 'arguments': {}}\n</TOOL_"
    );
  });

  test("Handle case where first tool in parallel calls succeeds and later tool fails (output handling)", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "Text before <TOOL_CALL>",
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: '{"name": "test", "arguments": ',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: '{"a1": "a1"}}</TOOL_CALL>',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: 'middle text <TOOL_CALL>{"nam',
        });
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: 'e": "',
        });
        // The second call stops before the tool call is completed
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

    const firstToolCall = chunks.find(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "tool-call" }> =>
        c.type === "tool-call"
    );
    expect(firstToolCall).toBeDefined();
    expect(firstToolCall?.toolName).toBe("test");
    expect(firstToolCall?.input).toBe('{"a1":"a1"}');

    // Incomplete tool call should be passed as text
    const textDeltaChunks = chunks.filter(
      (c): c is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
        c.type === "text-delta"
    );
    const textContent = textDeltaChunks.map((c) => c.delta).join("");

    expect(textContent).toEqual(
      'Text before \nmiddle text <TOOL_CALL>{"name": "'
    );
  });
});
