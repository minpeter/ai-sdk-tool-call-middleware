import { describe, test, expect } from "vitest";

import {
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
} from "@ai-sdk/provider";
import { convertToolPrompt } from "./conv-tool-prompt";

const TEST_TAGS = {
  toolCallTag: "<TOOL_CALL>",
  toolCallEndTag: "</TOOL_CALL>",
  toolResponseTag: "<TOOL_RESPONSE>",
  toolResponseEndTag: "</TOOL_RESPONSE>",
};

const TEST_TOOLS: LanguageModelV2FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the current weather in a given location",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and state, e.g. San Francisco, CA",
        },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "Unit for temperature",
        },
      },
      required: ["location"],
    },
  },
];

const simpleToolSystemPromptTemplate = (toolsString: string) =>
  `Tools available:\n${toolsString}`;

describe("convertToolPrompt", () => {
  // 1. Basic Tool Prompt Generation
  describe("Basic Tool Prompt Generation", () => {
    test("generates a system prompt with tool definitions for a user text prompt", () => {
      const testParamsPrompt: LanguageModelV2Prompt = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What is the weather today?",
            },
          ],
        },
      ];

      const result = convertToolPrompt({
        paramsPrompt: testParamsPrompt,
        paramsTools: TEST_TOOLS,
        toolSystemPromptTemplate: simpleToolSystemPromptTemplate,
        ...TEST_TAGS,
      });

      const expectedSystemPrompt = `Tools available:\n[["0",{"type":"function","name":"get_weather","description":"Get the current weather in a given location","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city and state, e.g. San Francisco, CA"},"unit":{"type":"string","enum":["celsius","fahrenheit"],"description":"Unit for temperature"}},"required":["location"]}}]]`;

      expect(result).toEqual([
        {
          role: "system",
          content: expectedSystemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What is the weather today?",
            },
          ],
        },
      ]);
    });
  });

  describe("Tool Call and Response Handling", () => {
    test("converts a single tool-call message to the expected tool call tag format", () => {
      const testParamsPrompt: LanguageModelV2Prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "12345",
              args: {
                location: "San Francisco, CA",
                unit: "celsius",
              },
            },
          ],
        },
      ];

      const result = convertToolPrompt({
        paramsPrompt: testParamsPrompt,
        paramsTools: [],
        toolSystemPromptTemplate: simpleToolSystemPromptTemplate,
        ...TEST_TAGS,
      });

      expect(result[1].content[0]).toEqual({
        type: "text",
        text: `<TOOL_CALL>{"arguments":{"location":"San Francisco, CA","unit":"celsius"},"name":"get_weather"}</TOOL_CALL>`,
      });
    });

    test("converts multiple tool-call messages into a single text block with tool call tags", () => {
      const testParamsPrompt: LanguageModelV2Prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "12345",
              args: {
                location: "San Francisco, CA",
                unit: "celsius",
              },
            },
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "67890",
              args: {
                location: "New York, NY",
                unit: "fahrenheit",
              },
            },
          ],
        },
      ];

      const result = convertToolPrompt({
        paramsPrompt: testParamsPrompt,
        paramsTools: [],
        toolSystemPromptTemplate: simpleToolSystemPromptTemplate,
        ...TEST_TAGS,
      });

      expect(result[1].content).toEqual([
        {
          type: "text",
          text: `<TOOL_CALL>{"arguments":{"location":"San Francisco, CA","unit":"celsius"},"name":"get_weather"}</TOOL_CALL>
<TOOL_CALL>{"arguments":{"location":"New York, NY","unit":"fahrenheit"},"name":"get_weather"}</TOOL_CALL>`,
        },
      ]);
    });

    test("combines text and multiple tool-call messages into a single text block with tool call tags", () => {
      const testParamsPrompt: LanguageModelV2Prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Calling tools to fetch weather information.",
            },
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "12345",
              args: {
                location: "San Francisco, CA",
                unit: "celsius",
              },
            },
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "67890",
              args: {
                location: "New York, NY",
                unit: "fahrenheit",
              },
            },
          ],
        },
      ];

      const result = convertToolPrompt({
        paramsPrompt: testParamsPrompt,
        paramsTools: [],
        toolSystemPromptTemplate: simpleToolSystemPromptTemplate,
        ...TEST_TAGS,
      });

      expect(result[1].content).toEqual([
        {
          type: "text",
          text: `Calling tools to fetch weather information.
<TOOL_CALL>{"arguments":{"location":"San Francisco, CA","unit":"celsius"},"name":"get_weather"}</TOOL_CALL>
<TOOL_CALL>{"arguments":{"location":"New York, NY","unit":"fahrenheit"},"name":"get_weather"}</TOOL_CALL>`,
        },
      ]);
    });

    test("interleaves text and tool-call messages, preserving order and formatting", () => {
      const testParamsPrompt: LanguageModelV2Prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "First, I will check the weather in San Francisco.",
            },
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "12345",
              args: {
                location: "San Francisco, CA",
                unit: "celsius",
              },
            },
            {
              type: "text",
              text: "Next, I will check the weather in New York.",
            },
            {
              type: "tool-call",
              toolName: "get_weather",
              toolCallId: "67890",
              args: {
                location: "New York, NY",
                unit: "fahrenheit",
              },
            },
            {
              type: "text",
              text: "Now, I will provide an answer based on the given information.",
            },
          ],
        },
      ];

      const result = convertToolPrompt({
        paramsPrompt: testParamsPrompt,
        paramsTools: [],
        toolSystemPromptTemplate: simpleToolSystemPromptTemplate,
        ...TEST_TAGS,
      });

      expect(result[1].content).toEqual([
        {
          type: "text",
          text: `First, I will check the weather in San Francisco.
<TOOL_CALL>{"arguments":{"location":"San Francisco, CA","unit":"celsius"},"name":"get_weather"}</TOOL_CALL>
Next, I will check the weather in New York.
<TOOL_CALL>{"arguments":{"location":"New York, NY","unit":"fahrenheit"},"name":"get_weather"}</TOOL_CALL>
Now, I will provide an answer based on the given information.`,
        },
      ]);
    });
  });
});
