import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

function emptyResult(): LanguageModelV4GenerateResult {
  return {
    content: [],
    finishReason: stopFinishReason,
    usage: zeroUsage,
    warnings: [],
  };
}

const protocolStream = vi.fn(async (_options?: LanguageModelV4CallOptions) => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>(),
}));

function contractModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => emptyResult(),
    doStream: protocolStream,
  };
}

describe("createToolMiddleware wrapGenerate protocol contract", () => {
  it("parses text content via protocol parseGeneratedText", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const generated = {
      ...emptyResult(),
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"t","arguments":{}}</tool_call>',
        },
      ],
    } satisfies LanguageModelV4GenerateResult;
    const result = await middleware.wrapGenerate?.({
      doGenerate: vi.fn(async () => generated),
      doStream: protocolStream,
      params: {
        prompt: [],
        tools: [
          {
            type: "function",
            name: "t",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
      model: contractModel(),
    });
    expect(result).toBeDefined();
    expect(
      result?.content.some((content) => content.type === "tool-call")
    ).toBe(true);
  });
});
