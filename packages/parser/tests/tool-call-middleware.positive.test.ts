import { describe, it, expect, vi } from "vitest";
import { createToolMiddleware } from "@/tool-call-middleware";
import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("createToolMiddleware positive paths", () => {
  it("wrapGenerate parses text content via protocol parseGeneratedText", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
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
    const result = await mw.wrapGenerate!({
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
    expect(result.content.some((c: any) => c.type === "tool-call")).toBe(true);
  });
});
