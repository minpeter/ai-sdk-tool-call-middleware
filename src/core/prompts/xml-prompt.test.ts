import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { transformParams } from "../../transform-handler";
import { xmlProtocol } from "../protocols/xml-protocol";
import { formatToolResponseAsXml, xmlSystemPromptTemplate } from "./xml-prompt";

describe("xml-prompt outer-layer transform", () => {
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
      protocol: xmlProtocol({}),
      placement: "first",
      toolSystemPromptTemplate: xmlSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsXml,
      params: {
        prompt: inputPrompt,
        tools,
      },
    });

    const expectedPrompt: LanguageModelV3Prompt = [
      {
        role: "system",
        content: xmlSystemPromptTemplate(tools),
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

    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });
});
