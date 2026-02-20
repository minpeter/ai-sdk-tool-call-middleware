import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Regex constants for performance
const _REGEX_ACCESS_TO_FUNCTIONS = /You have access to functions/;
const _REGEX_TOOL_CALL_FENCE = /```tool_call/;
const _REGEX_TOOL_RESPONSE_FENCE = /```tool_response/;
const _REGEX_GET_WEATHER = /get_weather/;
const _REGEX_FUNCTION_CALLING_MODEL = /You are a function calling AI model/;
const _REGEX_MAY_CALL_FUNCTIONS = /You may call one or more functions/;
const _REGEX_TOOLS_TAG = /<tools>/;
const _REGEX_NONE = /none/;
const _REGEX_NOT_FOUND = /not found/;
const _REGEX_PROVIDER_DEFINED = /Provider-defined tools/;
const _REGEX_REQUIRED_NO_TOOLS =
  /Tool choice type 'required' is set, but no tools are provided/;
const _REGEX_REQUIRED_NO_FUNCTION_TOOLS = /no function tools are provided/;
const _REGEX_TOOL_CALL_TAG = /<tool_call>/;
const _REGEX_TOOL_RESPONSE_TAG = /<tool_response>/;
const _REGEX_GET_WEATHER_TAG = /<get_weather>/;
const _REGEX_TOOL_CALL_WORD = /tool_call/;

describe("transformParams", () => {
  it("should transform params with tools into prompt", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: (tools) =>
        `You have tools: ${JSON.stringify(tools)}`,
    });

    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "test" }],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "getTool",
          description: "Gets a tool",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      ],
    };

    const transformParams = requireTransformParams(middleware.transformParams);
    const result = await transformParams({ params } as any);
    expect(result.prompt).toBeDefined();
    expect(result.tools).toEqual([]);
    expect(result.toolChoice).toBeUndefined();
  });

  it("should default to an empty tool list when tools are omitted", async () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: () => "SYSTEM: no tools",
    });

    const transformParams = requireTransformParams(middleware.transformParams);

    const result = await transformParams({
      params: {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "hello" }],
          },
        ],
        providerOptions: {
          toolCallMiddleware: {
            existing: true,
          },
        },
      },
    } as any);

    expect(result.prompt).toHaveLength(2);
    expect(result.prompt[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(result.prompt[1]).toEqual({
      role: "system",
      content: "SYSTEM: no tools",
    });
    expect(result.tools).toEqual([]);
    expect(
      (result.providerOptions as any).toolCallMiddleware.originalTools
    ).toEqual([]);
    expect((result.providerOptions as any).toolCallMiddleware.existing).toBe(
      true
    );
  });
});
