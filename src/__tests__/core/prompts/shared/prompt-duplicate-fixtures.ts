import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";

export const weatherInputExampleTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather by city",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      unit: { type: "string" },
    },
    required: ["city"],
  },
  inputExamples: [
    {
      input: {
        city: "Seoul",
        unit: "celsius",
      },
    },
  ],
};

export const canonicalFileToolResult: ToolResultPart = {
  type: "tool-result",
  toolCallId: "tc1",
  toolName: "screenshot",
  output: {
    type: "content",
    value: [
      { type: "text", text: "Screenshot captured" },
      {
        type: "file",
        data: { type: "data", data: "base64..." },
        mediaType: "image/png",
      },
    ],
  },
};

export const imageUrlToolResult: ToolResultPart = {
  type: "tool-result",
  toolCallId: "tc1",
  toolName: "vision",
  output: {
    type: "content",
    value: [{ type: "image-url", url: "https://example.com/a.png" }],
  },
};

export function stringInputExampleTool(
  name: string,
  property: string,
  value: string
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties: { [property]: { type: "string" } },
      required: [property],
    },
    inputExamples: [{ input: { [property]: value } }],
  };
}
