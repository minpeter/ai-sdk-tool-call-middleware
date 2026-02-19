import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
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

describe("placement last behaviour (default)", () => {
  it("does not append empty system message when rendered system prompt is empty", async () => {
    const mw = createToolMiddleware({
      placement: "last",
      protocol: hermesProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }

    const out = await transformParams({
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "A" }] }],
        tools: [],
      },
    } as any);

    expect(out.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "A" }] },
    ]);
  });

  it("default last: appends system at end when no system exists", async () => {
    const mw = createToolMiddleware({
      placement: "last",
      protocol: hermesProtocol,
      toolSystemPromptTemplate: (t) => `SYS:${t}`,
    });
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "op",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const transformParams = mw.transformParams;
    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }
    const out = await transformParams({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "A" }] },
          { role: "user", content: [{ type: "text", text: "B" }] },
        ],
        tools,
      },
    } as any);
    const last = out.prompt.at(-1);
    expect(last?.role).toBe("system");
    expect(String(last?.content)).toContain("SYS:");
    // users merged regardless of placement
    const userMsgs = out.prompt.filter((m: any) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const mergedText = (userMsgs[0].content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(mergedText).toContain("A");
    expect(mergedText).toContain("B");
  });

  it("last: merges with existing system at non-zero index (keeps one system)", async () => {
    const mw = createToolMiddleware({
      placement: "last",
      protocol: hermesProtocol,
      toolSystemPromptTemplate: (t) => `SYS:${t}`,
    });
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "op",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const transformParams = mw.transformParams;

    if (!transformParams) {
      throw new Error("transformParams is undefined");
    }

    const out = await transformParams({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "system", content: "BASE" },
          { role: "user", content: [{ type: "text", text: "world" }] },
        ],
        tools,
      },
    } as any);
    const systems = out.prompt.filter((m: any) => m.role === "system");
    expect(systems).toHaveLength(1);
    const system = systems[0];
    const text = String(system.content);
    expect(text.startsWith("BASE")).toBe(true);
    expect(text).toContain("SYS:");
  });
});
