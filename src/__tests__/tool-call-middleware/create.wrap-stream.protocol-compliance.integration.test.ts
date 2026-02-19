import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, test } from "vitest";

import { dummyProtocol } from "../../core/protocols/dummy-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { mockUsage, stopFinishReason, zeroUsage } from "../test-helpers";

describe("createToolMiddleware wrapStream protocol compliance integration", () => {
  const middleware = createToolMiddleware({
    protocol: dummyProtocol,
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

  test("should produce compliant start/delta/end pattern for text", async () => {
    const mockStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "Hello world" } as any);
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: mockUsage(1, 1),
        } as any);
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);
    const chunks = await convertReadableStreamToArray(result.stream);

    const MINIMUM_EXPECTED_CHUNKS = 3;
    expect(chunks.length).toBeGreaterThanOrEqual(MINIMUM_EXPECTED_CHUNKS);
    expect(chunks[0].type).toBe("text-start");
    const id = (chunks[0] as any).id;
    expect(chunks[1]).toEqual({ type: "text-delta", id, delta: "Hello world" });
    expect(chunks[2]).toEqual({ type: "text-end", id });
  });

  test("handles empty text chunks correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "" } as any);
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        } as any);
        controller.close();
      },
    });

    const result = await runMiddleware(mockStream);
    const chunks = await convertReadableStreamToArray(result.stream);

    const textChunks = chunks.filter(
      (c) =>
        c.type === "text-delta" ||
        c.type === "text-start" ||
        c.type === "text-end"
    );
    expect(textChunks).toHaveLength(0);
    expect(chunks.find((c) => c.type === "finish")).toBeDefined();
  });
});
