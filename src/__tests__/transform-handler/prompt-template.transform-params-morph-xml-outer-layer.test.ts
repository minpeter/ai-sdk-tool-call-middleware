import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  morphFormatToolResponseAsXml,
  morphXmlSystemPromptTemplate,
} from "../../core/prompts/morph-xml-prompt";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { transformParams } from "../../transform-handler";

function morphFixture(): {
  readonly prompt: LanguageModelV4Prompt;
  readonly tools: LanguageModelV4FunctionTool[];
} {
  const tools: LanguageModelV4FunctionTool[] = [
    {
      name: "get_weather",
      description: "Get weather by city",
      type: "function",
      inputSchema: {
        properties: { city: { type: "string" } },
        required: ["city"],
        type: "object",
      },
    },
  ];
  const prompt: LanguageModelV4Prompt = [
    {
      content: [{ text: "오늘 서울 날씨 알려줘", type: "text" }],
      role: "user",
    },
    {
      content: [
        {
          input: '{"city":"Seoul"}',
          toolCallId: "tc-weather",
          toolName: "get_weather",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "json",
            value: { city: "Seoul", temperature: 21 },
          },
          toolCallId: "tc-weather",
          toolName: "get_weather",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
  return { prompt, tools };
}

describe("transformParams morph-xml outer-layer transform", () => {
  it("transforms tools + messages into the expected prompt message array", () => {
    const fixture = morphFixture();
    const transformed = transformParams({
      protocol: morphXmlProtocol({}),
      placement: "first",
      toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
      toolResponsePromptTemplate: morphFormatToolResponseAsXml,
      params: fixture,
    });

    const expectedPrompt: LanguageModelV4Prompt = [
      {
        role: "system",
        content: morphXmlSystemPromptTemplate(fixture.tools),
      },
      fixture.prompt[0],
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `<get_weather>
  <city>Seoul</city>
</get_weather>`,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<tool_response>
  <tool_name>get_weather</tool_name>
  <result>
    <city>Seoul</city>
    <temperature>21</temperature>
  </result>
</tool_response>`,
          },
        ],
      },
    ];

    const {
      prompt: actualPrompt,
      tools: remainingTools,
      toolChoice,
    } = transformed;
    expect(actualPrompt).toEqual(expectedPrompt);
    expect(remainingTools).toEqual([]);
    expect(toolChoice).toBeUndefined();
  });
});
