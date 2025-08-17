import { describe, test, expect } from "vitest";
import { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { normalToolStream } from "./stream-handler";

describe("AI SDK v5 compatibility", () => {
  test("demonstrates the fix for start/delta/end pattern", async () => {
    // This test demonstrates that our implementation now follows
    // the AI SDK v5 stream protocol with start/delta/end pattern
    // instead of individual text-delta chunks

    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        // Simulate input that would previously break with individual text-delta chunks
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "Hello world",
        });
        controller.enqueue({
          type: "finish",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          finishReason: "stop",
        });
        controller.close();
      },
    });

    const mockDoStream = () =>
      Promise.resolve({
        stream: mockStream,
        request: {},
        response: {},
      });

    const result = await normalToolStream({
      doStream: mockDoStream,
      toolCallTag: "<TOOL_CALL>",
      toolCallEndTag: "</TOOL_CALL>",
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

    // Verify AI SDK v5 compliance
    expect(chunks).toHaveLength(4);

    // 1. Must start with text-start
    expect(chunks[0]).toMatchObject({
      type: "text-start",
      id: expect.any(String),
    });

    // Extract the id from the text-start chunk in a type-safe way
    const textStartId =
      chunks[0].type === "text-start" && "id" in chunks[0]
        ? chunks[0].id
        : undefined;
    expect(typeof textStartId).toBe("string");

    // 2. Followed by text-delta with same ID
    expect(chunks[1]).toMatchObject({
      type: "text-delta",
      id: textStartId, // Same ID as text-start

      delta: "Hello world",
    });

    expect(chunks[2]).toMatchObject({
      type: "text-end",
      id: textStartId, // Same ID as text-start and text-delta
    });

    // 4. Finally the finish chunk
    expect(chunks[3]).toMatchObject({
      type: "finish",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      finishReason: "stop",
    });
  });

  test("handles empty text chunks correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "input-id",
          delta: "", // Empty delta
        });
        controller.enqueue({
          type: "finish",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        });
        controller.close();
      },
    });

    const mockDoStream = () =>
      Promise.resolve({
        stream: mockStream,
        request: {},
        response: {},
      });

    const result = await normalToolStream({
      doStream: mockDoStream,
      toolCallTag: "<TOOL_CALL>",
      toolCallEndTag: "</TOOL_CALL>",
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

    // Should only have finish chunk - no text chunks for empty content
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "finish",
      finishReason: "stop",
    });
  });
});
