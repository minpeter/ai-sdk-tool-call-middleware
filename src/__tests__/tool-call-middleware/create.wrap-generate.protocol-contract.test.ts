import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate protocol contract", () => {
  it("parses text content via protocol parseGeneratedText", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });

    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"t","arguments":{}}</tool_call>',
        },
      ],
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate,
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
    } as any);

    expect(result).toBeDefined();
    expect(
      result?.content.some(
        (content: { type: string }) => content.type === "tool-call"
      )
    ).toBe(true);
  });
});
