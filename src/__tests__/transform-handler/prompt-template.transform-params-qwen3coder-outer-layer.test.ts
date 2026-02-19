import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "../../core/prompts/qwen3coder-prompt";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";
import { transformParams } from "../../transform-handler";

describe("transformParams qwen3coder outer-layer transform", () => {
  it("transforms tools + messages into the expected prompt message array", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    ];

    const inputPrompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "오늘 서울 날씨 알려줘" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-weather",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Seoul" }),
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
            output: {
              type: "json",
              value: {
                city: "Seoul",
                temperature: 21,
              },
            },
          },
        ],
      },
    ];

    const transformed = transformParams({
      protocol: qwen3CoderProtocol(),
      placement: "first",
      toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
      params: {
        prompt: inputPrompt,
        tools,
      },
    });

    const expectedPrompt: LanguageModelV3Prompt = [
      {
        role: "system",
        content: qwen3coderSystemPromptTemplate(tools),
      },
      {
        role: "user",
        content: [{ type: "text", text: "오늘 서울 날씨 알려줘" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `<tool_call>
  <function="get_weather">
    <parameter="city">Seoul</parameter>
  </function>
</tool_call>`,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<tool_response>
{"city":"Seoul","temperature":21}
</tool_response>`,
          },
        ],
      },
    ];

    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });
});
