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

  it("condenses multiple tool_response messages into single user text content", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: t => `T:${t}`,
    });

    const out = await mw.transformParams!({
      params: {
        prompt: [
          {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "a",
                output: {
                  type: "json",
                  value: {
                    city: "New York",
                    temperature: 25,
                    condition: "sunny",
                  },
                },
              },
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "b",
                output: {
                  type: "json",
                  value: {
                    city: "Los Angeles",
                    temperature: 58,
                    condition: "sunny",
                  },
                },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function" as const,
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);


    const userMsgs = out.prompt.filter(m => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const user = userMsgs[0] as any;
    // Single text content only
    expect(user.content.filter((c: any) => c.type === "text")).toHaveLength(1);
    const text = user.content[0].text as string;
    // Contains two tool_response blocks
    expect((text.match(/<tool_response>/g) || []).length).toBe(2);
    expect(user.content.length).toBe(1);
  });
});
