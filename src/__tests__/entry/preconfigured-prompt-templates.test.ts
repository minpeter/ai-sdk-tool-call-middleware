import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesToolMiddleware, morphXmlToolMiddleware } from "../../index";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Regex constants for performance
const _REGEX_ACCESS_TO_FUNCTIONS = /You have access to functions/;
const _REGEX_TOOL_CALL_FENCE = /```tool_call/;
const _REGEX_TOOL_RESPONSE_FENCE = /```tool_response/;
const REGEX_GET_WEATHER = /get_weather/;
const REGEX_FUNCTION_CALLING_MODEL = /You are a function calling AI model/;
const REGEX_MAY_CALL_FUNCTIONS = /You may call one or more functions/;
const REGEX_TOOLS_TAG = /<tools>/;
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

describe("preconfigured middleware prompt templates", () => {
  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ];

  it("hermesToolMiddleware template appears in system prompt", async () => {
    const transformParams = hermesToolMiddleware.transformParams as any;
    const out = await transformParams({
      params: { prompt: [], tools },
    } as any);

    const system = out.prompt[0];
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(REGEX_FUNCTION_CALLING_MODEL);
    expect(text).toMatch(REGEX_TOOLS_TAG);
    expect(text).toMatch(REGEX_GET_WEATHER);
  });

  it("morphXmlToolMiddleware template appears in system prompt", async () => {
    const transformParams = morphXmlToolMiddleware.transformParams as any;
    const out = await transformParams({
      params: { prompt: [], tools },
    } as any);

    const system = out.prompt[0];
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(REGEX_MAY_CALL_FUNCTIONS);
    expect(text).toMatch(REGEX_TOOLS_TAG);
    expect(text).toMatch(REGEX_GET_WEATHER);
  });
});
