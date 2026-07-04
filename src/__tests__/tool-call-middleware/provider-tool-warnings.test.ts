import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { wrapGenerate } from "../../generate-handler";
import { wrapStream } from "../../stream-handler";
import { createToolMiddleware } from "../../tool-call-middleware";
import { dummyProtocol } from "../fixtures/dummy-protocol";
import { requireTransformParams } from "../test-helpers";

const providerTool = {
  type: "provider" as const,
  id: "openai.web_search" as const,
  name: "web_search",
  args: {},
};

const functionTool = {
  type: "function" as const,
  name: "op",
  description: "desc",
  inputSchema: { type: "object" as const },
};

describe("provider tools are dropped with a spec warning", () => {
  it("transformParams records dropped provider tool names", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: (t) => `SYS:${t}`,
    });
    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [functionTool, providerTool],
      },
    } as any);

    expect(
      (
        out.providerOptions as {
          toolCallMiddleware?: { droppedProviderTools?: string[] };
        }
      ).toolCallMiddleware?.droppedProviderTools
    ).toEqual(["web_search"]);
  });

  it("wrapGenerate appends an unsupported warning for dropped tools", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hello" }],
      warnings: [],
      finishReason: { unified: "stop", raw: "stop" },
    });

    const result = await wrapGenerate({
      protocol: dummyProtocol(),
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: [{ name: "op", inputSchema: '{"type":"object"}' }],
            droppedProviderTools: ["web_search"],
          },
        },
      },
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: "unsupported",
        feature: "provider tool web_search",
      }),
    ]);
  });

  it("wrapStream appends the warning to stream-start", async () => {
    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 0,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 0, text: undefined, reasoning: undefined },
            },
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
            droppedProviderTools: ["web_search"],
          },
        },
      },
    });

    const parts = await convertReadableStreamToArray(result.stream);
    expect(parts[0]).toMatchObject({
      type: "stream-start",
      warnings: [
        expect.objectContaining({
          type: "unsupported",
          feature: "provider tool web_search",
        }),
      ],
    });
  });
});
