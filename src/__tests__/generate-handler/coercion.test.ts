import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
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

function generateContent(content: unknown[]) {
  return {
    content,
    finishReason: stopFinishReason,
    usage: zeroUsage,
    warnings: [],
  };
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
    const malformedToolCall = {
      type: "tool-call",
      toolCallId: "id",
      toolName: "calc",
      input: null,
    };
    const doGenerate = vi
      .fn()
      .mockResolvedValue(generateContent([malformedToolCall]));

    const result = await wrapGenerate({
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
    const doGenerate = vi.fn().mockResolvedValue(
      generateContent([
        {
          type: "tool-call",
          toolCallId: "id",
          toolName: "calc",
          input: null,
        },
      ])
    );

    const result = await wrapGenerate({
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

    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: "null",
    });
  });
});
