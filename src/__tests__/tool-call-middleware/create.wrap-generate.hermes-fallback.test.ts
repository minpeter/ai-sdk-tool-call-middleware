import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate hermes JSON fallback", () => {
  const mockToolSystemPromptTemplate = (tools: LanguageModelV4FunctionTool[]) =>
    `You have tools: ${JSON.stringify(tools)}`;
  const fallbackGenerated = {
    content: [],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: {
        total: 0,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 0, text: undefined, reasoning: undefined },
    },
    warnings: [],
  } satisfies LanguageModelV4GenerateResult;
  const fallbackStream = {
    stream: new ReadableStream(),
  } satisfies LanguageModelV4StreamResult;
  const doStream = vi.fn(async () => fallbackStream);
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => fallbackGenerated,
    doStream: async () => fallbackStream,
  };

  const createJsonMiddleware = () =>
    createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

  it("recovers bare JSON tool payload when protocol parsing returns no tool-call", async () => {
    const middleware = createJsonMiddleware();
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            unit: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
        },
      ],
      finishReason: fallbackGenerated.finishReason,
      usage: fallbackGenerated.usage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      doStream,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
      model,
    });

    const toolCall = result?.content.find((part) => part.type === "tool-call");

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("recovers single-tool bare arguments and drops schema-unknown keys", async () => {
    const middleware = createJsonMiddleware();
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
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"city":"Seoul","mood":"sunny"}',
        },
      ],
      finishReason: fallbackGenerated.finishReason,
      usage: fallbackGenerated.usage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      doStream,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
      model,
    });

    const toolCall = result?.content.find((part) => part.type === "tool-call");

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ city: "Seoul" });
  });

  it("preserves surrounding text when JSON fallback recovers from fenced payload", async () => {
    const middleware = createJsonMiddleware();
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            unit: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: [
            "Before",
            "```json",
            '{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
            "```",
            "After",
          ].join("\n"),
        },
      ],
      finishReason: fallbackGenerated.finishReason,
      usage: fallbackGenerated.usage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      doStream,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
      model,
    });

    expect(result?.content).toHaveLength(3);

    const [before, toolCall, after] = result?.content ?? [];
    if (!(before && toolCall && after)) {
      throw new Error("expected before, tool-call, and after content");
    }

    expect(before).toEqual({ type: "text", text: "Before\n" });
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
    if (toolCall.type === "tool-call") {
      expect(JSON.parse(toolCall.input)).toEqual({
        city: "Seoul",
        unit: "celsius",
      });
    }
    expect(after).toEqual({ type: "text", text: "\nAfter" });
  });

  it("recovers arguments-only JSON object for single strict tool schema", async () => {
    const middleware = createJsonMiddleware();
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            unit: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"city":"Busan","unit":"celsius"}' }],
      finishReason: fallbackGenerated.finishReason,
      usage: fallbackGenerated.usage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      doStream,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
      model,
    });

    const toolCall = result?.content.find((part) => part.type === "tool-call");
    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      city: "Busan",
      unit: "celsius",
    });
  });

  it("does not recover arguments-only JSON when keys do not match strict schema", async () => {
    const middleware = createJsonMiddleware();
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
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
      finishReason: fallbackGenerated.finishReason,
      usage: fallbackGenerated.usage,
      warnings: [],
    } satisfies LanguageModelV4GenerateResult);

    const result = await middleware.wrapGenerate?.({
      doGenerate,
      doStream,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
      model,
    });

    expect(result?.content).toEqual([{ type: "text", text: '{"foo":"bar"}' }]);
  });
});
