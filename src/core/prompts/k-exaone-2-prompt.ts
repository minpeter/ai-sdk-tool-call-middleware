import {
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { stringifyKExaone2NativeSchemaJson } from "./k-exaone-2-native-json";
import { formatToolResponseWithMedia } from "./shared/tool-response-with-media";
import type { ToolResponseMediaStrategy } from "./shared/tool-result-normalizer";
import type { ToolResponsePromptTemplateResult } from "./shared/tool-result-user-content";

const K_EXAONE_2_TOOL_CALL_FORMAT = `# Tool Call Format
<tool_call>
<function=example_tool_name>
<parameter=arg1>
value1
</parameter>
<parameter=arg2>
2
</parameter>
</function>
</tool_call>`;

function isSchemaObject(
  value: LanguageModelV4FunctionTool["inputSchema"] | string
): value is LanguageModelV4FunctionTool["inputSchema"] & JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInputSchema(
  inputSchema: LanguageModelV4FunctionTool["inputSchema"] | string
): JSONValue {
  if (typeof inputSchema !== "string") {
    return isSchemaObject(inputSchema) || isJSONValue(inputSchema)
      ? inputSchema
      : null;
  }

  try {
    const parsed = JSON.parse(inputSchema);
    return isJSONValue(parsed) ? parsed : inputSchema;
  } catch {
    return inputSchema;
  }
}

const K_EXAONE_TOOL_DELIMITER_ERROR =
  "K-EXAONE tool names and descriptions must not contain <tool> or </tool>.";

function containsToolDelimiter(value: string | undefined): boolean {
  return (
    value?.includes("<tool>") === true || value?.includes("</tool>") === true
  );
}

export function renderKExaoneNativeTool(
  tool: LanguageModelV4FunctionTool
): string {
  if (
    containsToolDelimiter(tool.name) ||
    containsToolDelimiter(tool.description)
  ) {
    throw new Error(K_EXAONE_TOOL_DELIMITER_ERROR);
  }
  const functionProperties = [
    `"name": ${JSON.stringify(tool.name)}`,
    ...(tool.description === undefined
      ? []
      : [`"description": ${JSON.stringify(tool.description)}`]),
    `"parameters": ${stringifyKExaone2NativeSchemaJson(normalizeInputSchema(tool.inputSchema))}`,
  ];
  const declaration = `{"type": "function", "function": {${functionProperties.join(", ")}}}`;
  return `<tool>${declaration}</tool>`;
}

export function kExaone2SystemPromptTemplate(
  tools: LanguageModelV4FunctionTool[]
): string {
  if (tools.length === 0) {
    return "";
  }

  const declarations = tools.map(renderKExaoneNativeTool).join("\n");
  const prompt = `# Tools
The available tools are defined below in JSON format.
When calling a tool, use XML with <function=...> and one <parameter=...> block per argument.

${declarations}

${K_EXAONE_2_TOOL_CALL_FORMAT}`;
  return prompt;
}

interface KExaone2ToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
}

function stringifyToolResponseContent(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatToolResponseAsKExaone2WithOptions(
  toolResult: ToolResultPart,
  options?: KExaone2ToolResponseFormatterOptions
): ToolResponsePromptTemplateResult {
  return formatToolResponseWithMedia({
    toolResult,
    mediaStrategy: options?.mediaStrategy,
    wrapContent: (content) =>
      `<tool_result>${stringifyToolResponseContent(content)}</tool_result>`,
  });
}

export function createKExaone2ToolResponseFormatter(
  options?: KExaone2ToolResponseFormatterOptions
): (toolResult: ToolResultPart) => ToolResponsePromptTemplateResult {
  return (toolResult) =>
    formatToolResponseAsKExaone2WithOptions(toolResult, options);
}

export function formatToolResponseAsKExaone2(
  toolResult: ToolResultPart
): ToolResponsePromptTemplateResult {
  return formatToolResponseAsKExaone2WithOptions(toolResult);
}
