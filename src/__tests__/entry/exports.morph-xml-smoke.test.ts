import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlToolMiddleware, originalToolsSchema } from "../../index";

describe("entry exports morph-xml smoke", () => {
  it("parses XML tool calls with arguments", async () => {
    const mockDoGenerate = () =>
      Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: "<get_weather><location>San Francisco</location></get_weather>",
          },
        ] as LanguageModelV3Content[],
      });

    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get the weather",
        inputSchema: { type: "object" },
      },
    ];

    const result = await morphXmlToolMiddleware.wrapGenerate?.({
      doGenerate: mockDoGenerate,
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
    if (!result) {
      throw new Error("result is undefined");
    }

    const toolCalls = result.content.filter(
      (
        content
      ): content is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
        content.type === "tool-call"
    );

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].input)).toEqual({
      location: "San Francisco",
    });
  });

  it("parses XML tool calls with no arguments", async () => {
    const mockDoGenerate = () =>
      Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: "<get_location></get_location>",
          },
        ] as LanguageModelV3Content[],
      });

    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_location",
        description: "Get the user's location",
        inputSchema: { type: "object" },
      },
    ];

    const result = await morphXmlToolMiddleware.wrapGenerate?.({
      doGenerate: mockDoGenerate,
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
    if (!result) {
      throw new Error("result is undefined");
    }

    const toolCalls = result.content.filter(
      (
        content
      ): content is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
        content.type === "tool-call"
    );

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe("get_location");
    expect(JSON.parse(toolCalls[0].input)).toEqual({});
  });
});
