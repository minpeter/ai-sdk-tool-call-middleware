import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { stringifyKExaone2NativeSchemaJson } from "./k-exaone-2-native-json";

export const K_EXAONE_236B_TOOL_CALL_FORMAT = `# Tool Call Format
When calling a tool, output exactly one JSON object inside <tool_call> tags:
<tool_call>{"name":"example_tool_name","arguments":{"arg1":"value1"}}</tool_call>
Use the declared tool name and argument keys.
`;

function normalizeInputSchema(inputSchema: unknown): unknown {
  if (typeof inputSchema !== "string") {
    return inputSchema;
  }

  try {
    return JSON.parse(inputSchema);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return inputSchema;
    }
    throw error;
  }
}

function renderTool(tool: LanguageModelV4FunctionTool): string {
  const functionProperties = [
    `"name": ${JSON.stringify(tool.name)}`,
    ...(tool.description === undefined
      ? []
      : [`"description": ${JSON.stringify(tool.description)}`]),
    `"parameters": ${stringifyKExaone2NativeSchemaJson(normalizeInputSchema(tool.inputSchema))}`,
  ];

  return `<tool>{"type": "function", "function": {${functionProperties.join(", ")}}}</tool>`;
}

export function kExaone236BToolDeclaration(
  tools: LanguageModelV4FunctionTool[]
): string {
  if (tools.length === 0) {
    return "";
  }

  return `# Tools\n${tools.map(renderTool).join("\n")}\n`;
}
