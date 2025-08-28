import { describe, it, expect, vi } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol } from "./protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("createToolMiddleware positive paths", () => {
  it("transformParams injects system prompt and merges consecutive user texts", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: t => `SYS:${t}`,
    });
    const tools = [
      {
        type: "function",
        name: "op",
        description: "desc",
        inputSchema: { type: "object" },
      },
    ];
    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "A" }] },
          { role: "user", content: [{ type: "text", text: "B" }] },
        ],
        tools,
      },
    } as any);
    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("SYS:");
    // merged two user messages
    const mergedUser = out.prompt[1];
    expect(mergedUser.role).toBe("user");
    const text = (mergedUser.content as any[])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

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
