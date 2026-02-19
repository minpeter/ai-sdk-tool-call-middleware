import { describe, expect, it, vi } from "vitest";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
} from "../../preconfigured-middleware";

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
const REGEX_TOOL_CALL_TAG = /<tool_call>/;
const REGEX_TOOL_RESPONSE_TAG = /<tool_response>/;
const REGEX_GET_WEATHER_TAG = /<get_weather>/;
const _REGEX_TOOL_CALL_WORD = /tool_call/;

describe("non-stream assistant->user merge formatting with object input", () => {
  it("hermes: formats assistant tool-call (object input) and tool result into user text", async () => {
    const mw = hermesToolMiddleware;
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "get_weather",
                input: JSON.stringify({ city: "Seoul" }),
              } as any,
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "tc1",
                output: { ok: true },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
    if (!assistantMsg) {
      throw new Error("assistant message not found");
    }
    const assistantText = (assistantMsg.content as any[])
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(assistantText).toMatch(REGEX_TOOL_CALL_TAG);

    const userMsgs = out.prompt.filter((m: any) => m.role === "user");
    const userCombined = userMsgs
      .map((u: any) =>
        u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toMatch(REGEX_TOOL_RESPONSE_TAG);
  });

  it("xml: formats assistant tool-call (object input) and tool result into user text", async () => {
    const mw = morphXmlToolMiddleware;
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "get_weather",
                input: JSON.stringify({ city: "Seoul" }),
              } as any,
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "tc1",
                output: { ok: true },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    const assistantMsg = out.prompt.find((m: any) => m.role === "assistant");
    if (!assistantMsg) {
      throw new Error("assistant message not found");
    }
    const assistantText = (assistantMsg.content as any[])
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(assistantText).toMatch(REGEX_GET_WEATHER_TAG);

    const userMsgs = out.prompt.filter((m: any) => m.role === "user");
    const userCombined = userMsgs
      .map((u: any) =>
        u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toMatch(REGEX_TOOL_RESPONSE_TAG);
  });
});
