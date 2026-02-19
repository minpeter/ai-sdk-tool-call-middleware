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
const REGEX_NOT_FOUND = /not found/;
const REGEX_PROVIDER_DEFINED = /Provider-defined tools/;
const REGEX_REQUIRED_NO_TOOLS =
  /Tool choice type 'required' is set, but no tools are provided/;
const REGEX_REQUIRED_NO_FUNCTION_TOOLS = /no function tools are provided/;
const _REGEX_TOOL_CALL_TAG = /<tool_call>/;
const _REGEX_TOOL_RESPONSE_TAG = /<tool_response>/;
const _REGEX_GET_WEATHER_TAG = /<get_weather>/;
const _REGEX_TOOL_CALL_WORD = /tool_call/;

describe("createToolMiddleware transformParams error branches", () => {
  const mw = createToolMiddleware({
    protocol: hermesProtocol,
    toolSystemPromptTemplate: (t) => `T:${t}`,
  });

  it("throws when specific tool not found", async () => {
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    await expect(
      transformParams({
        params: {
          prompt: [],
          tools: [],
          toolChoice: { type: "tool", toolName: "missing" },
        },
      } as any)
    ).rejects.toThrow(REGEX_NOT_FOUND);
  });

  it("throws when provider-defined tool is selected", async () => {
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    await expect(
      transformParams({
        params: {
          prompt: [],
          tools: [{ type: "provider-defined", id: "x" } as any],
          toolChoice: { type: "tool", toolName: "x" },
        },
      } as any)
    ).rejects.toThrow(REGEX_PROVIDER_DEFINED);
  });

  it("throws when required toolChoice is set but no tools are provided", async () => {
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    await expect(
      transformParams({
        params: { prompt: [], tools: [], toolChoice: { type: "required" } },
      } as any)
    ).rejects.toThrow(REGEX_REQUIRED_NO_TOOLS);
  });

  it("throws when required toolChoice is set but tools are provider-defined only", async () => {
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    await expect(
      transformParams({
        params: {
          prompt: [],
          tools: [{ type: "provider-defined", id: "x" } as any],
          toolChoice: { type: "required" },
        },
      } as any)
    ).rejects.toThrow(REGEX_REQUIRED_NO_FUNCTION_TOOLS);
  });
});
