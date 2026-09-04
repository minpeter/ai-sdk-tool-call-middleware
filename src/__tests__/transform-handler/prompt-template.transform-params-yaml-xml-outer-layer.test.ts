import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  formatToolResponseAsYaml,
  yamlXmlSystemPromptTemplate,
} from "../../core/prompts/yaml-xml-prompt";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { transformParams } from "../../transform-handler";

const yamlTools: LanguageModelV4FunctionTool[] = [
  {
    description: "Get weather by city",
    inputSchema: {
      properties: { city: { type: "string" } },
      type: "object",
      required: ["city"],
    },
    name: "get_weather",
    type: "function",
  },
];

function yamlInputPrompt(): LanguageModelV4Prompt {
  const cityInput = JSON.stringify({ city: "Seoul" });
  return [
    {
      role: "user",
      content: [{ text: "오늘 서울 날씨 알려줘", type: "text" }],
    },
    {
      role: "assistant",
      content: [
        {
          toolCallId: "tc-weather",
          input: cityInput,
          type: "tool-call",
          toolName: "get_weather",
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          toolCallId: "tc-weather",
          output: {
            value: { city: "Seoul", temperature: 21 },
            type: "json",
          },
          type: "tool-result",
          toolName: "get_weather",
        },
      ],
    },
  ];
}

describe("transformParams yaml-xml outer-layer transform", () => {
  it("transforms tools + messages into the expected prompt message array", () => {
    const prompt = yamlInputPrompt();
    const transformed = transformParams({
      params: { prompt, tools: yamlTools },
      toolResponsePromptTemplate: formatToolResponseAsYaml,
      toolSystemPromptTemplate: yamlXmlSystemPromptTemplate,
      placement: "first",
      protocol: yamlXmlProtocol({}),
    });

    const expectedPrompt: LanguageModelV4Prompt = [
      { content: yamlXmlSystemPromptTemplate(yamlTools), role: "system" },
      prompt[0],
      {
        content: [
          {
            text: `<get_weather>
city: Seoul
</get_weather>`,
            type: "text",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            text: `<tool_response>
  <tool_name>get_weather</tool_name>
  <result>
    <city>Seoul</city>
    <temperature>21</temperature>
  </result>
</tool_response>`,
            type: "text",
          },
        ],
        role: "user",
      },
    ];

    expect(transformed.toolChoice).toBeUndefined();
    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
  });
});
