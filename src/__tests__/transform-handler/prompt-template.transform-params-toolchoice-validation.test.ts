import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";

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
const REGEX_NONE = /none/;
const _REGEX_NOT_FOUND = /not found/;
const _REGEX_PROVIDER_DEFINED = /Provider-defined tools/;
const _REGEX_REQUIRED_NO_TOOLS =
  /Tool choice type 'required' is set, but no tools are provided/;
const _REGEX_REQUIRED_NO_FUNCTION_TOOLS = /no function tools are provided/;
const _REGEX_TOOL_CALL_TAG = /<tool_call>/;
const _REGEX_TOOL_RESPONSE_TAG = /<tool_response>/;
const _REGEX_GET_WEATHER_TAG = /<get_weather>/;
const _REGEX_TOOL_CALL_WORD = /tool_call/;

describe("transformParams toolChoice validation", () => {
  it("transformParams throws on toolChoice type none", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    await expect(
      transformParams({
        params: { prompt: [], tools: [], toolChoice: { type: "none" } },
      } as any)
    ).rejects.toThrow(REGEX_NONE);
  });

  it("transformParams validates specific tool selection and builds JSON schema", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const tools = [
      {
        type: "function",
        name: "t1",
        description: "d",
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
      },
    ];
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const result = await transformParams({
      params: {
        prompt: [],
        tools,
        toolChoice: { type: "tool", toolName: "t1" },
      },
    } as any);
    expect(result.responseFormat).toMatchObject({ type: "json", name: "t1" });
    expect(
      (result.providerOptions as any).toolCallMiddleware.toolChoice
    ).toEqual({ type: "tool", toolName: "t1" });
  });

  it("transformParams required builds if/then/else schema", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const tools = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
      {
        type: "function",
        name: "b",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const result = await transformParams({
      params: { prompt: [], tools, toolChoice: { type: "required" } },
    } as any);
    expect(result.responseFormat).toMatchObject({ type: "json" });
    expect(
      (result.providerOptions as any).toolCallMiddleware.toolChoice
    ).toEqual({ type: "required" });
  });
});
