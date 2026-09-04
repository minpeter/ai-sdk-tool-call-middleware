import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, test } from "vitest";
import { createToolMiddleware } from "../../tool-call-middleware";
import { dummyProtocol } from "../fixtures/dummy-protocol";
import { mockUsage, stopFinishReason, zeroUsage } from "../test-helpers";

describe("createToolMiddleware wrapStream protocol compliance integration", () => {
  const middleware = createToolMiddleware({
    protocol: dummyProtocol,
    toolSystemPromptTemplate: () => "",
  });
  const generateResult = {
    content: [],
    finishReason: stopFinishReason,
    usage: zeroUsage,
    warnings: [],
  } satisfies LanguageModelV4GenerateResult;
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => generateResult,
    doStream: async () => ({ stream: new ReadableStream() }),
  };

  const runMiddleware = (stream: ReadableStream<LanguageModelV4StreamPart>) => {
    const mockDoStream = () => Promise.resolve({ stream });
    if (!middleware.wrapStream) {
      throw new Error("wrapStream is not defined");
    }
    return middleware.wrapStream({
      doGenerate: async () => generateResult,
      doStream: mockDoStream,
      params: { prompt: [] },
      model,
    });
  };

  test("should produce compliant start/delta/end pattern for text", async () => {
    const mockStream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "text-1",
          delta: "Hello world",
        });
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

    const MINIMUM_EXPECTED_CHUNKS = 3;
    expect(chunks.length).toBeGreaterThanOrEqual(MINIMUM_EXPECTED_CHUNKS);
    const [firstChunk] = chunks;
    expect(firstChunk?.type).toBe("text-start");
    if (firstChunk?.type !== "text-start") {
      throw new Error("expected a text-start chunk");
    }
    expect(chunks[1]).toEqual({
      type: "text-delta",
      id: firstChunk.id,
      delta: "Hello world",
    });
    expect(chunks[2]).toEqual({ type: "text-end", id: firstChunk.id });
  });

  test("handles empty text chunks correctly", async () => {
    const mockStream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta: "" });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
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
