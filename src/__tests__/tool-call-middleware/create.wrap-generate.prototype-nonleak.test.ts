import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

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
  const multiTools: LanguageModelV4FunctionTool[] = [
    ...tools,
    {
      type: "function",
      name: "lookup",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
    },
  ];

  function generateWithProtocol(
    protocol: TCMCoreProtocol,
    text: string,
    toolDefs = tools
  ) {
    const middleware = createToolMiddleware({
      protocol,
      toolSystemPromptTemplate: (promptToolDefs: unknown[]) =>
        `You have tools: ${JSON.stringify(promptToolDefs)}`,
    });
    const generated = {
      content: [{ type: "text", text }],
      finishReason: stopFinishReason,
      usage: zeroUsage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult;
    const streamResult = {
      stream: new ReadableStream(),
    } satisfies LanguageModelV4StreamResult;
    const doGenerate = vi.fn(async () => generated);
    const doStream = vi.fn(async () => streamResult);
    const params = {
      prompt: [],
      tools: toolDefs,
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(toolDefs),
        },
      },
    } satisfies LanguageModelV4CallOptions;
    const model: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate,
      doStream,
    };

    const { wrapGenerate } = middleware;
    if (!wrapGenerate) {
      return;
    }
    return wrapGenerate({ doGenerate, doStream, params, model });
  }

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

  it("does not leak prototype-sensitive incomplete Hermes tool-call text on generated-text fallback", async () => {
    const result = await generateWithProtocol(
      hermesProtocol({}),
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}'
    );

    expect(result?.content).toEqual([]);
  });

  it("does not leak prototype-sensitive incomplete Hermes text with unicode-escaped name keys", async () => {
    const result = await generateWithProtocol(
      hermesProtocol({}),
      '<tool_call>{"n\\u0061me":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      multiTools
    );

    expect(result?.content).toEqual([]);
  });

  it("does not leak prototype-sensitive incomplete Hermes text with unicode-escaped tool names", async () => {
    const result = await generateWithProtocol(
      hermesProtocol({}),
      '<tool_call>{"name":"get_\\u0077eather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      multiTools
    );

    expect(result?.content).toEqual([]);
  });

  it("does not leak prototype-sensitive incomplete Morph XML tool-call text on generated-text fallback", async () => {
    const result = await generateWithProtocol(
      morphXmlProtocol({}),
      "<get_weather><city>Seoul</city><constructor><polluted>true</polluted>"
    );

    expect(result?.content).toEqual([]);
  });

  it("does not leak prototype-sensitive incomplete YAML XML tool-call text on generated-text fallback", async () => {
    const result = await generateWithProtocol(
      yamlXmlProtocol({}),
      "<get_weather>city: Seoul\nconstructor:\n  polluted: true"
    );

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

  it("does not leak mixed recovered and sensitive JSON candidates before Morph XML calls", async () => {
    const result = await generateWithProtocol(
      morphXmlProtocol({}),
      [
        '{"name":"lookup","arguments":{"query":"safe"}}',
        '{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}}',
        "<get_weather><city>Busan</city></get_weather>",
      ].join(" "),
      multiTools
    );

    const text = result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toBe("");
    expect(JSON.stringify(result?.content)).not.toContain("constructor");
    expect(JSON.stringify(result?.content)).not.toContain("polluted");
    expect(result?.content).toHaveLength(2);
    expect(result?.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "lookup",
      input: '{"query":"safe"}',
    });
    expect(result?.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: '{"city":"Busan"}',
    });
  });
});
