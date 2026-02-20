import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";

export const emptyFunctionTools: LanguageModelV3FunctionTool[] = [];

export function createOperationTools(
  description = ""
): LanguageModelV3FunctionTool[] {
  return [
    {
      type: "function",
      name: "op",
      description,
      inputSchema: { type: "object" },
    },
  ];
}
