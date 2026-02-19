import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware wrapGenerate hermes JSON fallback", () => {
  const mockToolSystemPromptTemplate = (tools: unknown[]) =>
    `You have tools: ${JSON.stringify(tools)}`;

  const createJsonMiddleware = () =>
    createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

  it("recovers bare JSON tool payload when protocol parsing returns no tool-call", async () => {
    const middleware = createJsonMiddleware();
    const tools: LanguageModelV3FunctionTool[] = [
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

    const toolCall = result?.content.find(
      (part: unknown) => (part as { type?: string }).type === "tool-call"
    ) as { toolName: string; input: string } | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("preserves surrounding text when JSON fallback recovers from fenced payload", async () => {
    const middleware = createJsonMiddleware();
    const tools: LanguageModelV3FunctionTool[] = [
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

    expect(result?.content).toHaveLength(3);

    const [before, toolCall, after] = (result?.content ?? []) as Array<
      | { type: "text"; text: string }
      | { type: "tool-call"; toolName: string; input: string }
    >;

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
    const tools: LanguageModelV3FunctionTool[] = [
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

    const toolCall = result?.content.find(
      (part: unknown) => (part as { type?: string }).type === "tool-call"
    ) as { toolName: string; input: string } | undefined;
    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      city: "Busan",
      unit: "celsius",
    });
  });

  it("does not recover arguments-only JSON when keys do not match strict schema", async () => {
    const middleware = createJsonMiddleware();
    const tools: LanguageModelV3FunctionTool[] = [
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

    expect(result?.content).toEqual([{ type: "text", text: '{"foo":"bar"}' }]);
  });
});
