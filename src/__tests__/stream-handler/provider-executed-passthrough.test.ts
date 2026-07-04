import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { wrapStream } from "../../stream-handler";
import { dummyProtocol } from "../fixtures/dummy-protocol";

const zeroUsage = {
  inputTokens: {
    total: 0,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 0, text: undefined, reasoning: undefined },
};

describe("wrapStream provider-executed tool calls", () => {
  it("passes provider-executed calls through byte-identical and keeps finishReason", async () => {
    const providerExecutedCall = {
      type: "tool-call" as const,
      toolCallId: "srv-1",
      toolName: "web_search",
      // A bare JSON string input that client-schema coercion would rewrite.
      input: '"42"',
      providerExecuted: true,
    };

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(providerExecutedCall);
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: zeroUsage,
          });
          controller.close();
        },
      }),
    });

    const result = await wrapStream({
      protocol: dummyProtocol(),
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: [{ name: "op", inputSchema: '{"type":"object"}' }],
          },
        },
      },
    });

    const parts = await convertReadableStreamToArray(result.stream);
    const toolCall = parts.find((part) => part.type === "tool-call");
    expect(toolCall).toEqual(providerExecutedCall);

    // A provider-executed call does not signal a pending client execution.
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
    });
  });
});
