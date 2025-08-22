import { describe, test, expect } from "vitest";
import { convertToolPrompt } from "./conv-tool-prompt";
import {
  LanguageModelV2Prompt,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";

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
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "The city and state" },
      },
      required: ["location"],
    },
  },
];

describe("convertToolPrompt basic", () => {
  test("produces system prompt and passes through user prompt", () => {
    const paramsPrompt: LanguageModelV2Prompt = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    const result = convertToolPrompt({
      paramsPrompt,
      paramsTools: TEST_TOOLS,
      toolSystemPromptTemplate: (s: string) => `Tools:\n${s}`,
      ...TEST_TAGS,
    });

    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
  });
});
