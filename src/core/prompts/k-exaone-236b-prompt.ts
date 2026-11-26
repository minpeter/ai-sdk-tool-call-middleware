import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { renderKExaoneNativeTool } from "./k-exaone-2-prompt";

export const K_EXAONE_236B_TOOL_CALL_FORMAT = `# Tool Call Format
When calling a tool, output exactly one JSON object inside <tool_call> tags:
<tool_call>{"name":"example_tool_name","arguments":{"arg1":"value1"}}</tool_call>
Use the declared tool name and argument keys.
`;

export function kExaone236BToolDeclaration(
  tools: LanguageModelV4FunctionTool[]
): string {
  if (tools.length === 0) {
    return "";
  }

  return `# Tools\n${tools.map(renderKExaoneNativeTool).join("\n")}\n`;
}

export function kExaone236BSystemPromptMessages(
  tools: LanguageModelV4FunctionTool[]
): LanguageModelV4Prompt {
  const declaration = kExaone236BToolDeclaration(tools);
  if (declaration.length === 0) {
    return [];
  }

  return [
    {
      role: "system",
      content: declaration,
      providerOptions: {
        openaiCompatible: {
          role: "tool_declare",
        },
      },
    },
    {
      role: "system",
      content: K_EXAONE_236B_TOOL_CALL_FORMAT,
    },
  ];
}
