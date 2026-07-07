import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate prototype-sensitive non-leak", () => {
  const tools: LanguageModelV4FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
      },
    },
  ];

  it("does not leak prototype-sensitive Hermes tool-call text on generated-text fallback", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (toolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(toolDefs)}`,
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}}</tool_call>',
        },
      ],
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    } as any);

    expect(result?.content).toEqual([]);
  });
});
