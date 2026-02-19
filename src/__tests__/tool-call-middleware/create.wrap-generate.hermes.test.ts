import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate hermes", () => {
  const mockToolSystemPromptTemplate = (tools: unknown[]) =>
    `You have tools: ${JSON.stringify(tools)}`;

  const createJsonMiddleware = () =>
    createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

  it("parses tool calls from text content", async () => {
    const middleware = createJsonMiddleware();
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: 'Some text <tool_call>{"name": "getTool", "arguments": {"arg1": "value1"}}</tool_call> more text',
        },
      ],
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      params: { prompt: [] },
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

  it("passes through non-text content unchanged", async () => {
    const middleware = createJsonMiddleware();
    const original = {
      type: "tool-call" as const,
      toolCallId: "id1",
      toolName: "t",
      input: "{}",
    };
    const doGenerate = vi.fn().mockResolvedValue({
      content: [original],
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      params: { prompt: [] },
    } as any);

    expect(result).toBeDefined();
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual(original);
  });
});
