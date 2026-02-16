import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import {
  type ToolResponseMediaStrategy,
  unwrapToolResult,
} from "./shared/tool-response";

export interface JsonInXmlToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
}

function formatToolResponseAsJsonInXmlWithOptions(
  toolResult: ToolResultPart,
  options?: JsonInXmlToolResponseFormatterOptions
): string {
  const unwrappedResult = unwrapToolResult(
    toolResult.output,
    options?.mediaStrategy
  );
  return `<tool_response>${JSON.stringify({
    toolName: toolResult.toolName,
    result: unwrappedResult,
  })}</tool_response>`;
}

export function createJsonInXmlToolResponseFormatter(
  options?: JsonInXmlToolResponseFormatterOptions
): (toolResult: ToolResultPart) => string {
  return (toolResult) =>
    formatToolResponseAsJsonInXmlWithOptions(toolResult, options);
}

export function formatToolResponseAsJsonInXml(
  toolResult: ToolResultPart
): string {
  return formatToolResponseAsJsonInXmlWithOptions(toolResult);
}

export function hermesSystemPromptTemplate(
  tools: LanguageModelV3FunctionTool[]
): string {
  const toolsJson = JSON.stringify(tools);
  return `You are a function calling AI model.
You are provided with function signatures within <tools></tools> XML tags.
You may call one or more functions to assist with the user query.
Don't make assumptions about what values to plug into functions.
Here are the available tools: <tools>${toolsJson}</tools>
Use the following pydantic model json schema for each tool call you will make: {"title": "FunctionCall", "type": "object", "properties": {"arguments": {"title": "Arguments", "type": "object"}, "name": {"title": "Name", "type": "string"}}, "required": ["arguments", "name"]}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>`;
}
