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

const complianceGenerateResult = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

const complianceModel: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => complianceGenerateResult,
  doStream: async () => ({ stream: new ReadableStream() }),
};

function partStream(
  parts: readonly LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

async function collectCompliantStream(
  parts: readonly LanguageModelV4StreamPart[]
): Promise<LanguageModelV4StreamPart[]> {
  const middleware = createToolMiddleware({
    protocol: dummyProtocol,
    toolSystemPromptTemplate: () => "",
  });
  if (!middleware.wrapStream) {
    throw new Error("wrapStream is not defined");
  }
  const result = await middleware.wrapStream({
    doGenerate: async () => complianceGenerateResult,
    doStream: async () => ({ stream: partStream(parts) }),
    params: { prompt: [] },
    model: complianceModel,
  });
  return convertReadableStreamToArray(result.stream);
}

describe("createToolMiddleware wrapStream protocol compliance integration", () => {
  test("should produce compliant start/delta/end pattern for text", async () => {
    const chunks = await collectCompliantStream([
      { type: "text-delta", id: "text-1", delta: "Hello world" },
      {
        type: "finish",
        finishReason: stopFinishReason,
        usage: mockUsage(1, 1),
      },
    ]);
    const minimumExpectedChunks = 3;
    expect(chunks.length).toBeGreaterThanOrEqual(minimumExpectedChunks);
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
    const chunks = await collectCompliantStream([
      { type: "text-delta", id: "text-1", delta: "" },
      { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
    ]);
    const textChunks = chunks.filter(
      (chunk) =>
        chunk.type === "text-delta" ||
        chunk.type === "text-start" ||
        chunk.type === "text-end"
    );
    expect(textChunks).toHaveLength(0);
    expect(chunks.find((chunk) => chunk.type === "finish")).toBeDefined();
  });
});
