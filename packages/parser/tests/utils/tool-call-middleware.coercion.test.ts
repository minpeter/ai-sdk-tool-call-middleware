import { describe, expect, it, vi } from "vitest";

import { ToolCallProtocol } from "@/protocols/tool-call-protocol";
import { createToolMiddleware } from "@/tool-call-middleware";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Minimal protocol that emits a fixed XML-like payload but routes through middleware coercion
const dummyProtocol: ToolCallProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate("[]"),
  formatToolCall: () => "",
  formatToolResponse: () => "",
  parseGeneratedText: ({ tools }) => [
    {
      type: "tool-call",
      toolCallId: "id",
      toolName: tools[0]?.name ?? "calc",
      input: JSON.stringify({ a: "10", b: "false" }),
    } as any,
  ],
  createStreamParser: () => new TransformStream(),
};

describe("tool-call-middleware coercion (utils)", () => {
  it("coerces using jsonSchema wrapper in tools via middleware", async () => {
    const middleware = createToolMiddleware({
      protocol: dummyProtocol,
      toolSystemPromptTemplate: () => "",
    });

    const tools = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "boolean" },
            },
          },
        },
      },
    ] as any;

    const result = await middleware.wrapGenerate!({
      doGenerate: async () =>
        ({ content: [{ type: "text", text: "" }] }) as any,
      params: { tools },
    } as any);

    const tc = (result.content as any[]).find(
      (p: any) => p.type === "tool-call"
    );
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ a: 10, b: false });
  });
});
