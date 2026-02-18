import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import {
  type ToolResponseMediaStrategy,
  unwrapToolResult,
} from "./shared/tool-result-normalizer";

export interface HermesToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
}

function formatToolResponseAsHermesWithOptions(
  toolResult: ToolResultPart,
  options?: HermesToolResponseFormatterOptions
): string {
  const unwrappedResult = unwrapToolResult(
    toolResult.output,
    options?.mediaStrategy
  );
  return `<tool_response>${JSON.stringify({
    name: toolResult.toolName,
    content: unwrappedResult,
  })}</tool_response>`;
}

export function createHermesToolResponseFormatter(
  options?: HermesToolResponseFormatterOptions
): (toolResult: ToolResultPart) => string {
  return (toolResult) =>
    formatToolResponseAsHermesWithOptions(toolResult, options);
}

export function formatToolResponseAsHermes(toolResult: ToolResultPart): string {
  return formatToolResponseAsHermesWithOptions(toolResult);
}

// Maps JSON Schema type to Python type string (matches vLLM json_to_python_type macro)
export function jsonSchemaToPythonType(
  schema: Record<string, unknown>
): string {
  const type = schema.type;

  if (type === "string") {
    return "str";
  }
  if (type === "number") {
    return "float";
  }
  if (type === "integer") {
    return "int";
  }
  if (type === "boolean") {
    return "bool";
  }

  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      return `list[${jsonSchemaToPythonType(items)}]`;
    }
    return "list[Any]";
  }

  if (type === "object") {
    const additionalProperties = schema.additionalProperties as
      | Record<string, unknown>
      | undefined;
    if (additionalProperties) {
      return `dict[str, ${jsonSchemaToPythonType(additionalProperties)}]`;
    }
    return "dict";
  }

  if (Array.isArray(type)) {
    return `Union[${type.map((t: string) => jsonSchemaToPythonType({ type: t })).join(",")}]`;
  }

  return "Any";
}

export function renderToolDefinition(
  tool: LanguageModelV3FunctionTool
): string {
  const schema = tool.inputSchema as Record<string, unknown>;
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  const paramSignature = properties
    ? Object.entries(properties)
        .map(([name, field]) => `${name}: ${jsonSchemaToPythonType(field)}`)
        .join(", ")
    : "";

  const desc = tool.description ?? "";
  let description = `${tool.name}(${paramSignature}) - ${desc}\n\n`;

  if (properties && Object.keys(properties).length > 0) {
    description += "    Args:\n";
    for (const [paramName, paramFields] of Object.entries(properties)) {
      const paramDesc = (paramFields.description as string | undefined) ?? "";
      description += `        ${paramName}(${jsonSchemaToPythonType(paramFields)}): ${paramDesc.trim()}\n`;
    }
  }

  const parametersJson = JSON.stringify(schema);
  const descJson = JSON.stringify(description);
  const nameJson = JSON.stringify(tool.name);

  return `{"type": "function", "function": {"name": ${nameJson}, "description": ${descJson}, "parameters": ${parametersJson}}}`;
}

export function hermesSystemPromptTemplate(
  tools: LanguageModelV3FunctionTool[]
): string {
  const toolsRendered = tools.map(renderToolDefinition).join("\n");
  return `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools> ${toolsRendered} </tools>
Use the following pydantic model json schema for each tool call you will make: {"properties": {"name": {"title": "Name", "type": "string"}, "arguments": {"title": "Arguments", "type": "object"}}, "required": ["name", "arguments"], "title": "FunctionCall", "type": "object"}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>`;
}
