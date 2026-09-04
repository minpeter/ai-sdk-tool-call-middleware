import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, test, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { mockUsage, stopFinishReason, zeroUsage } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const hermesGenerateResult = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

const hermesModel: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => hermesGenerateResult,
  doStream: async () => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>(),
  }),
};

function hermesInputStream(deltas: readonly string[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: mockUsage(1, 1),
      });
      controller.close();
    },
  });
}

async function collectHermesMiddleware(
  deltas: readonly string[]
): Promise<LanguageModelV4StreamPart[]> {
  const middleware = createToolMiddleware({
    protocol: hermesProtocol,
    toolSystemPromptTemplate: () => "",
  });
  if (!middleware.wrapStream) {
    throw new Error("wrapStream is not defined");
  }
  const result = await middleware.wrapStream({
    doStream: async () => ({ stream: hermesInputStream(deltas) }),
    doGenerate: async () => hermesGenerateResult,
    params: { prompt: [] },
    model: hermesModel,
  });
  return convertReadableStreamToArray(result.stream);
}

describe("createToolMiddleware hermes stream compat", () => {
  test("wrapStream parses legacy tool_call payload into tool-call event", async () => {
    const chunks = await collectHermesMiddleware([
      "<tool_call>",
      '{"name": "get_weather", "arguments": {"location": "NY"}}',
      "</tool_call>",
    ]);
    const toolCallChunks = chunks.flatMap((chunk) =>
      chunk.type === "tool-call" ? [chunk] : []
    );
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: '{"location":"NY"}',
    });
    const finish = chunks.find((chunk) => chunk.type === "finish");
    expect(finish).toBeDefined();
    expect(finish?.finishReason).toEqual({
      unified: "tool-calls",
      raw: "stop",
    });
  });

  test("wrapStream suppresses malformed legacy tool_call markup by default", async () => {
    const chunks = await collectHermesMiddleware([
      "<tool_call>invalid json</tool_call>",
    ]);
    const textContent = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    expect(textContent).not.toContain("<tool_call>");
    expect(textContent).not.toContain("</tool_call>");
    const finish = chunks.find((chunk) => chunk.type === "finish");
    expect(finish).toBeDefined();
    expect(finish?.finishReason).toEqual({ unified: "stop", raw: undefined });
  });
});
