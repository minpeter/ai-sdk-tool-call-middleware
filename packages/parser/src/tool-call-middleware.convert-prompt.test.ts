import { describe, it, expect, vi } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol } from "./protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("transformParams convertToolPrompt mapping and merge", () => {
  const mw = createToolMiddleware({
    protocol: jsonMixProtocol,
    toolSystemPromptTemplate: t => `TOOLS:${t}`,
  });

  it("converts assistant tool-call and tool role messages, merges adjacent user texts, and preserves providerOptions", async () => {
    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hello" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            { type: "text", text: "aside" },
            { foo: "bar" } as any,
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result",
              toolName: "t1",
              toolCallId: "tc1",
              output: { ok: true },
            },
            { toolName: "t1", toolCallId: "tc1", output: { alt: 1 } } as any,
          ],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" },
        },
      ],
      providerOptions: { toolCallMiddleware: { existing: true } },
    };

    const out = await mw.transformParams!({ params } as any);
    expect(out.prompt[0].role).toBe("system");
    // Assistant remains assistant with formatted tool call text
    const assistantMsg = out.prompt.find(m => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    const assistantText = assistantMsg!.content
      .map(c => (c.type === "text" ? (c as any).text : ""))
      .join("");
    expect(assistantText).toMatch(/<tool_call>/);

    // Tool role becomes user text; original user remains user; they are not adjacent so not merged
    const userMsgs = out.prompt.filter(m => m.role === "user");
    expect(userMsgs.length).toBe(2);
    const userCombined = userMsgs
      .map(u =>
        u.content.map(c => (c.type === "text" ? (c as any).text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toContain("hello");
    expect(userCombined).toMatch(/<tool_response>/);

    // tools cleared; toolNames propagated into providerOptions
    expect(out.tools).toEqual([]);
    const toolNames = (out.providerOptions as any).toolCallMiddleware.toolNames;
    expect(toolNames).toEqual(["t1"]);
    // existing provider option preserved
    expect((out.providerOptions as any).toolCallMiddleware.existing).toBe(true);
  });
});
