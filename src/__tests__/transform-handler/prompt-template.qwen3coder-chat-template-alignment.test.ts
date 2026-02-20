import { describe, expect, it, vi } from "vitest";
import {
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "../../core/prompts/qwen3coder-prompt";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";
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

describe("qwen3coder chat-template alignment via existing transform pipeline", () => {
  it("keeps existing system text first, renders tools section, converts assistant tool-call markup, and maps tool messages to user <tool_response>", async () => {
    const mw = createToolMiddleware({
      protocol: qwen3CoderProtocol,
      toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
    });

    const transformParams = requireTransformParams(mw.transformParams);

    const out = await transformParams({
      params: {
        prompt: [
          { role: "system", content: "Follow policy." },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc-weather",
                toolName: "get_weather",
                input: JSON.stringify({
                  city: "Seoul",
                  options: { unit: "celsius" },
                  days: 3,
                  strict: false,
                }),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-weather",
                toolName: "get_weather",
                output: { type: "json", value: { temperature: 21 } },
              },
              {
                type: "tool-result",
                toolCallId: "tc-time",
                toolName: "get_time",
                output: { type: "json", value: { time: "10:00" } },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Weather lookup",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          },
        ],
      },
    } as any);

    const system = out.prompt.find((m) => m.role === "system");
    if (!system) {
      throw new Error("system message not found");
    }
    const systemText = String(system.content);
    expect(systemText.startsWith("Follow policy.\n\n# Tools\n\n")).toBe(true);
    expect(systemText).toContain("<tools>");
    expect(systemText).toContain("<function>");
    expect(systemText).toContain("<name>get_weather</name>");

    const assistant = out.prompt.find((m) => m.role === "assistant") as
      | { content: Array<{ type: string; text?: string }> }
      | undefined;
    if (!assistant) {
      throw new Error("assistant message not found");
    }
    const assistantText = assistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    expect(assistantText).toContain("<tool_call>");
    expect(assistantText).toContain('<function="get_weather">');
    expect(assistantText).toContain(
      '<parameter="options">{"unit":"celsius"}</parameter>'
    );
    expect(assistantText).toContain('<parameter="days">3</parameter>');
    expect(assistantText).toContain('<parameter="strict">False</parameter>');

    const user = out.prompt.find((m) => m.role === "user") as
      | { content: Array<{ type: string; text?: string }> }
      | undefined;
    if (!user) {
      throw new Error("user message not found");
    }
    const userText = user.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    expect(userText).toContain(
      '<tool_response>\n{"temperature":21}\n</tool_response>'
    );
    expect(userText).toContain(
      '<tool_response>\n{"time":"10:00"}\n</tool_response>'
    );
    expect(userText).not.toContain("<tool_name>");
  });
});
