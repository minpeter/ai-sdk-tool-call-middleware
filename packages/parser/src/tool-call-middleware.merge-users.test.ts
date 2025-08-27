import { describe, it, expect } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol } from "./protocols/json-mix-protocol";

describe("transformParams merges adjacent user messages", () => {
  it("merges two consecutive user messages into one with newline", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: t => `T:${t}`,
    });

    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
        tools: [],
      },
    } as any);

    // After inserting system, the merged user should be at index 1
    const user = out.prompt.find(m => m.role === "user")!;
    const text = user.content.map((c: any) => c.text).join("");
    expect(text).toBe("first\nsecond");
  });
});
