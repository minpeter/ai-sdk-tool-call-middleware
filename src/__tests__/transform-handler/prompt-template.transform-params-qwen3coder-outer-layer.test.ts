import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "../../core/prompts/qwen3coder-prompt";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";
import { transformParams } from "../../transform-handler";

const qwenWeatherTool: LanguageModelV4FunctionTool = {
  inputSchema: {
    type: "object",
    required: ["city"],
    properties: { city: { type: "string" } },
  },
  description: "Get weather by city",
  name: "get_weather",
  type: "function",
};

function qwenConversation(): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  prompt.push({
    role: "user",
    content: [{ type: "text", text: "오늘 서울 날씨 알려줘" }],
  });
  prompt.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolName: "get_weather",
        toolCallId: "tc-weather",
        input: JSON.stringify({ city: "Seoul" }),
      },
    ],
  });
  prompt.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "get_weather",
        toolCallId: "tc-weather",
        output: {
          value: { city: "Seoul", temperature: 21 },
          type: "json",
        },
      },
    ],
  });
  return prompt;
}

describe("transformParams qwen3coder outer-layer transform", () => {
  it("transforms tools + messages into the expected prompt message array", () => {
    const tools = [qwenWeatherTool];
    const inputPrompt = qwenConversation();
    const transformed = transformParams({
      params: { tools, prompt: inputPrompt },
      protocol: qwen3CoderProtocol(),
      placement: "first",
      toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
    });

    const expectedPrompt: LanguageModelV4Prompt = [
      {
        content: qwen3coderSystemPromptTemplate(tools),
        role: "system",
      },
      inputPrompt[0],
      {
        content: [
          {
            text: `<tool_call>
  <function="get_weather">
    <parameter="city">Seoul</parameter>
  </function>
</tool_call>`,
            type: "text",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            text: `<tool_response>
{"city":"Seoul","temperature":21}
</tool_response>`,
            type: "text",
          },
        ],
        role: "user",
      },
    ];

    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });
});
