import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { jsonMixProtocol } from "../protocols/json-mix-protocol";
import { createToolMiddleware } from "../tool-call-middleware";

describe("tool middleware placement option", () => {
  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "op",
      description: "d",
      inputSchema: { type: "object" },
    },
  ];

  it("placement=last appends system message at the end when no system exists", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: (t) => `TOOLS:${t}`,
      placement: "last",
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

    expect(out.prompt.at(-1)?.role).toBe("system");
    expect(String(out.prompt.at(-1)?.content)).toContain("TOOLS:");
    expect(out.prompt[0].role).toBe("user");
  });

  it("placement=first prepends system message before user when no system exists", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
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
