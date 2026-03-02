import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Minimal protocol that emits a fixed XML-like payload but routes through middleware coercion
const dummyProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
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

    const tools: LanguageModelV3FunctionTool[] = [
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

  it("applies coerce.maxDepth from provider options", async () => {
    const deepProtocol: TCMCoreProtocol = {
      ...dummyProtocol,
      parseGeneratedText: ({ tools }) => [
        {
          type: "tool-call",
          toolCallId: "id",
          toolName: tools[0]?.name ?? "deep",
          input: JSON.stringify({
            outer: {
              inner: {
                count: "12",
              },
            },
          }),
        } as any,
      ],
    };
    const middleware = createToolMiddleware({
      protocol: deepProtocol,
      toolSystemPromptTemplate: () => "",
    });

    const onMaxDepthExceeded = vi.fn();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "deep",
        inputSchema: {
          type: "object",
          properties: {
            outer: {
              type: "object",
              properties: {
                inner: {
                  type: "object",
                  properties: {
                    count: { type: "number" },
                  },
                },
              },
            },
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
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
            coerce: {
              maxDepth: 2,
              onMaxDepthExceeded,
            },
          },
        },
      },
    } as any);

    const tc = (result.content as any[]).find(
      (p: any) => p.type === "tool-call"
    );
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({
      outer: {
        inner: {
          count: "12",
        },
      },
    });
    expect(onMaxDepthExceeded).toHaveBeenCalled();
  });
});
