import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
} from "../../core/prompts/hermes-prompt";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { transformParams } from "../../transform-handler";

function hermesWeatherTool(): LanguageModelV4FunctionTool {
  return {
    name: "get_weather",
    type: "function",
    description: "Get weather by city",
    inputSchema: {
      required: ["city"],
      properties: { city: { type: "string" } },
      type: "object",
    },
  };
}

const userMessage: LanguageModelV4Prompt[number] = {
  role: "user",
  content: [{ type: "text", text: "오늘 서울 날씨 알려줘" }],
};
const assistantCall: LanguageModelV4Prompt[number] = {
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: "tc-weather",
      toolName: "get_weather",
      input: JSON.stringify({ city: "Seoul" }),
    },
  ],
};
const weatherResult: LanguageModelV4Prompt[number] = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "tc-weather",
      toolName: "get_weather",
      output: {
        type: "json",
        value: { city: "Seoul", temperature: 21 },
      },
    },
  ],
};

describe("transformParams hermes outer-layer transform", () => {
  it("transforms tools + messages into the expected prompt message array", () => {
    const tools = [hermesWeatherTool()];
    const inputPrompt: LanguageModelV4Prompt = [
      userMessage,
      assistantCall,
      weatherResult,
    ];

    const transformed = transformParams({
      protocol: hermesProtocol(),
      placement: "first",
      toolSystemPromptTemplate: hermesSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsHermes,
      params: { prompt: inputPrompt, tools },
    });

    const expectedPrompt: LanguageModelV4Prompt = [
      { role: "system", content: hermesSystemPromptTemplate(tools) },
      userMessage,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<tool_response>{"name":"get_weather","content":{"city":"Seoul","temperature":21}}</tool_response>',
          },
        ],
      },
    ];

    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });
});
