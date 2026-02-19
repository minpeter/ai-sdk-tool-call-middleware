import { describe, expect, it, vi } from "vitest";
import { formatToolResponseAsHermes } from "../../core/prompts/hermes-prompt";
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

describe("transformParams merges adjacent user messages", () => {
  it("merges two consecutive user messages into one with newline", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      placement: "first",
      toolSystemPromptTemplate: (t) => `T:${t}`,
    });

    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
        tools: [],
      },
    } as any);

    // After inserting system, the merged user should be at index 1
    const user = out.prompt.find((m) => m.role === "user");
    if (!user) {
      throw new Error("user message not found");
    }
    const text = user.content.map((c: any) => c.text).join("");
    expect(text).toBe("first\nsecond");
  });

  it("condenses multiple tool_response messages into single user text content", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      placement: "first",
      toolSystemPromptTemplate: (t) => `T:${t}`,
      toolResponsePromptTemplate: formatToolResponseAsHermes,
    });

    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({
      params: {
        prompt: [
          {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "a",
                output: {
                  type: "json",
                  value: {
                    city: "New York",
                    temperature: 25,
                    condition: "sunny",
                  },
                },
              },
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "b",
                output: {
                  type: "json",
                  value: {
                    city: "Los Angeles",
                    temperature: 58,
                    condition: "sunny",
                  },
                },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function" as const,
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    const userMsgs = out.prompt.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const user = userMsgs[0] as any;
    // Single text content only
    expect(user.content.filter((c: any) => c.type === "text")).toHaveLength(1);
    const text = user.content[0].text as string;
    // Contains two tool_response blocks
    expect((text.match(/<tool_response>/g) || []).length).toBe(2);
    expect(user.content.length).toBe(1);
  });
});
