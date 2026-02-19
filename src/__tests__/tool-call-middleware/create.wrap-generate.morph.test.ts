import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate morph", () => {
  const mockToolSystemPromptTemplate = (tools: unknown[]) =>
    `You have tools: ${JSON.stringify(tools)}`;

  it("parses XML tool calls from text content", async () => {
    const middleware = createToolMiddleware({
      protocol: morphXmlProtocol,
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "getTool",
        description: "Gets a tool",
        inputSchema: { type: "object" },
      },
    ];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Some text <getTool><arg1>value1</arg1></getTool> more text",
        },
      ],
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    } as any);

    expect(result).toBeDefined();
    expect(result?.content).toHaveLength(3);
    expect(result?.content[0]).toEqual({ type: "text", text: "Some text " });
    expect(result?.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "getTool",
      input: '{"arg1":"value1"}',
    });
    expect(result?.content[2]).toEqual({ type: "text", text: " more text" });
  });
});
