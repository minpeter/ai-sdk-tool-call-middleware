import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import type { TCMCoreProtocol } from "../core/protocols/protocol-interface";
import { originalToolsSchema } from "../core/utils/provider-options";
import { wrapStream } from "../stream-handler";

const passthroughProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: () => [],
  createStreamParser: () => new TransformStream(),
};

describe("wrapStream tool-call coercion", () => {
  it("coerces streamed tool-call input using originalTools schema", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "boolean" },
          },
        },
      },
    ];

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: "id",
            toolName: "calc",
            input: '{"a":"10","b":"false"}',
          });
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: "tool-calls",
              raw: "tool-calls",
            },
            usage: {
              inputTokens: {
                total: 0,
                noCache: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: 0,
                text: 0,
                reasoning: 0,
              },
            },
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
      input: '{"a":10,"b":false}',
    });
  });
});
