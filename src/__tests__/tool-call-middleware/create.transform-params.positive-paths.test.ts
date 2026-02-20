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

describe("createToolMiddleware transformParams positive paths", () => {
  it("transformParams injects system prompt and merges consecutive user texts", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      placement: "first",
      toolSystemPromptTemplate: (t) => `SYS:${t}`,
    });
    const tools = [
      {
        type: "function",
        name: "op",
        description: "desc",
        inputSchema: { type: "object" },
      },
    ];
    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "A" }] },
          { role: "user", content: [{ type: "text", text: "B" }] },
        ],
        tools,
      },
    } as any);
    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("SYS:");
    // merged two user messages
    const mergedUser = out.prompt[1];
    expect(mergedUser.role).toBe("user");
    const text = (mergedUser.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });
});
