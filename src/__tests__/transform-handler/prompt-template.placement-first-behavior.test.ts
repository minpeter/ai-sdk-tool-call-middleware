import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("placement first behavior", () => {
  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "op",
      description: "d",
      inputSchema: { type: "object" },
    },
  ];

  it("placement=first prepends system message before user when no system exists", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: (t) => `TOOLS:${t}`,
      placement: "first",
    });

    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({
      params: {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "hello" }],
          },
        ],
        tools,
      },
    } as any);

    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("TOOLS:");
  });
});
