import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapGenerate } from "../../generate-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

const passthroughProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: () => [],
  createStreamParser: () => new TransformStream(),
};

interface GenerateToolCallIngress {
  readonly input: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly type: "tool-call";
}

function generateContent(
  content: readonly GenerateToolCallIngress[]
): LanguageModelV4GenerateResult {
  if (content.length === 0 || content.some(({ input }) => input !== null)) {
    throw new TypeError("Expected malformed generate content with null input");
  }

  const result: LanguageModelV4GenerateResult = {
    content: [],
    finishReason: stopFinishReason,
    usage: zeroUsage,
    warnings: [],
  };
  Object.defineProperty(result, "content", {
    enumerable: true,
    value: content,
  });
  return result;
}

function runMalformedGenerate(
  tools: LanguageModelV4FunctionTool[],
  toolCall: GenerateToolCallIngress
): Promise<LanguageModelV4GenerateResult> {
  const doGenerate = vi.fn().mockResolvedValue(generateContent([toolCall]));
  return wrapGenerate({
    protocol: passthroughProtocol,
    doGenerate,
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
  });
}

describe("wrapGenerate tool-call coercion", () => {
  it("leaves generated null tool-call input unchanged for non-nullable schemas", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" } },
        },
      },
    ];
    const malformedToolCall: GenerateToolCallIngress = {
      type: "tool-call",
      toolCallId: "id",
      toolName: "calc",
      input: null,
    };
    expect(() =>
      generateContent([{ ...malformedToolCall, input: "{}" }])
    ).toThrow(TypeError);
    const result = await runMalformedGenerate(tools, malformedToolCall);

    expect(result.content[0]).toBe(malformedToolCall);
  });

  it("preserves generated null tool-call input for nullable schemas", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: ["object", "null"],
          properties: { a: { type: "number" } },
        },
      },
    ];
    const result = await runMalformedGenerate(tools, {
      type: "tool-call",
      toolCallId: "id",
      toolName: "calc",
      input: null,
    });

    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: "null",
    });
  });
});
