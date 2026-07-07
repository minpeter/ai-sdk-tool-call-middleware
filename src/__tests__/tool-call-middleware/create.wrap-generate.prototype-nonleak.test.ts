import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate prototype-sensitive non-leak", () => {
  const tools: LanguageModelV4FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
      },
    },
  ];

  it("does not leak prototype-sensitive Hermes tool-call text on generated-text fallback", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (toolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(toolDefs)}`,
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}}</tool_call>',
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

    expect(result?.content).toEqual([]);
  });

  it("redacts debugSummary originalText for prototype-sensitive generated tool-call text", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (toolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(toolDefs)}`,
    });
    const debugSummary: { originalText?: string; toolCalls?: string } = {};
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}}</tool_call>',
        },
      ],
    });

    await middleware.wrapGenerate?.({
      doGenerate,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            debugSummary,
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    } as any);

    expect(debugSummary.originalText).toBe("[redacted sensitive tool call]");
    expect(JSON.stringify(debugSummary)).not.toContain("constructor");
    expect(JSON.stringify(debugSummary)).not.toContain("polluted");
  });

  it("redacts debugSummary provider-executed tool inputs while preserving pass-through content", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (toolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(toolDefs)}`,
    });
    const debugSummary: { originalText?: string; toolCalls?: string } = {};
    const providerExecutedCall = {
      type: "tool-call",
      toolCallId: "provider-call-1",
      toolName: "web_search",
      providerExecuted: true,
      input: '{"constructor":{"polluted":true}}',
    };
    const doGenerate = vi.fn().mockResolvedValue({
      content: [providerExecutedCall],
      finishReason: { raw: "stop", unified: "stop" },
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            debugSummary,
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    } as any);

    expect(result?.content).toEqual([providerExecutedCall]);
    expect(debugSummary.toolCalls).toContain("[redacted sensitive tool call]");
    expect(debugSummary.toolCalls).not.toContain("constructor");
    expect(debugSummary.toolCalls).not.toContain("polluted");
  });

  it("does not leak prototype-sensitive bare JSON recovery candidates", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (toolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(toolDefs)}`,
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"name":"get_weather","arguments":{"city":"Seoul","\\u0063onstructor":{"polluted":true}}}',
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

    expect(result?.content).toEqual([]);
  });

  it("preserves surrounding generated text around dropped sensitive JSON candidates", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (toolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(toolDefs)}`,
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: 'Before {"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}} after',
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

    expect(result?.content).toEqual([
      { type: "text", text: "Before " },
      { type: "text", text: " after" },
    ]);
  });
});
