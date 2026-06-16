import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";

export const emptyFunctionTools: LanguageModelV4FunctionTool[] = [];

export function createOperationTools(
  description = ""
): LanguageModelV4FunctionTool[] {
  return [
    {
      type: "function",
      name: "op",
      description,
      inputSchema: { type: "object" },
    },
  ];
}
