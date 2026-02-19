import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";

export const basicTools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the weather for a location",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
  {
    type: "function",
    name: "get_location",
    description: "Get the current location",
    inputSchema: { type: "object" },
  },
];

export const fileTools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["file_path", "contents"],
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read content from a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
];
