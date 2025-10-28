import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import type { ToolCallProtocol } from "@/protocols/tool-call-protocol";
import { createToolMiddleware } from "@/tool-call-middleware";
import { originalToolsSchema } from "@/utils/provider-options";

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

    const tools: LanguageModelV2FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "boolean" },
          },
        },
      },
    ];

    if (!middleware.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await middleware.wrapGenerate({
      doGenerate: async () =>
        ({ content: [{ type: "text", text: "" }] }) as any,
      params: {
        tools,
        providerOptions: {
          // INFO: Since this test does not go through the transform handler
          // that normally injects this, we need to provide it manually.
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    } as any);

    const tc = (result.content as any[]).find(
      (p: any) => p.type === "tool-call"
    );
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ a: 10, b: false });
  });
});
