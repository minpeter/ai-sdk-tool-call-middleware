import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";

const passthroughProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: () => [],
  createStreamParser: () => new TransformStream(),
};

describe("wrapStream null input coercion", () => {
  it("leaves streamed null tool-call input unchanged for non-nullable schemas", async () => {
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
    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(malformedToolCall);
          controller.close();
        },
      }),
    });

    const result = await wrapStream({
      protocol: passthroughProtocol,
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    });
    const parts = await convertReadableStreamToArray(result.stream);

    expect(parts[0]).toBe(malformedToolCall);
  });

  it("preserves streamed null tool-call input for nullable schemas", async () => {
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

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: "id",
            toolName: "calc",
            input: null,
          });
          controller.close();
        },
      }),
    });

    const result = await wrapStream({
      protocol: passthroughProtocol,
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    });
    const parts = await convertReadableStreamToArray(result.stream);

    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: "null",
    });
  });
});
