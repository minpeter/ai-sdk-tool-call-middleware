import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesToolMiddleware, morphXmlToolMiddleware } from "../../index";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const REGEX_GET_WEATHER = /get_weather/;
const REGEX_FUNCTION_CALLING_MODEL = /You are a function calling AI model/;
const REGEX_MAY_CALL_FUNCTIONS = /You may call one or more functions/;
const REGEX_TOOLS_TAG = /<tools>/;

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
