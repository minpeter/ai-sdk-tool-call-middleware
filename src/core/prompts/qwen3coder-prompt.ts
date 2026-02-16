import type {
  JSONValue,
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import type { TCMCoreProtocol } from "../protocols/protocol-interface";
import {
  type AssistantToolCallTextConversionOptions,
  assistantToolCallsToTextContent,
  type ToolResponseMediaStrategy,
  unwrapToolResult,
} from "./shared";

const QWEN3CODER_TOOL_HEADER =
  "# Tools\n\nYou have access to the following functions:\n\n";

const QWEN3CODER_TOOL_CALL_INSTRUCTIONS =
  "\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>";

type Mapping = Record<string, unknown>;

interface Qwen3CoderToolShape extends Mapping {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function toJinjaString(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

function toJinjaTrimmedString(value: unknown): string {
  return toJinjaString(value).trim();
}

function renderExtraKeys(
  jsonDict: unknown,
  handledKeys: readonly string[]
): string {
  if (!isMapping(jsonDict)) {
    return "";
  }

  const handled = new Set(handledKeys);
  let out = "";

  for (const [jsonKey, jsonValue] of Object.entries(jsonDict)) {
    if (handled.has(jsonKey)) {
      continue;
    }

    const renderedValue =
      isMapping(jsonValue) || isSequence(jsonValue)
        ? JSON.stringify(jsonValue)
        : toJinjaString(jsonValue);
    out += `\n<${jsonKey}>${renderedValue}</${jsonKey}>`;
  }

  return out;
}

function normalizeInputSchema(inputSchema: unknown): unknown {
  if (typeof inputSchema !== "string") {
    return inputSchema;
  }

  try {
    return JSON.parse(inputSchema) as unknown;
  } catch {
    return inputSchema;
  }
}

function normalizeTool(
  rawTool: LanguageModelV3FunctionTool
): Qwen3CoderToolShape {
  return {
    name: rawTool.name,
    description: rawTool.description,
    parameters: normalizeInputSchema(rawTool.inputSchema),
  };
}

function renderParameter(paramName: string, paramFieldsRaw: unknown): string {
  const paramFields = isMapping(paramFieldsRaw)
    ? (paramFieldsRaw as Mapping)
    : undefined;

  let out = "\n<parameter>";
  out += `\n<name>${paramName}</name>`;

  if (paramFields?.type !== undefined) {
    out += `\n<type>${toJinjaString(paramFields.type)}</type>`;
  }

  if (paramFields?.description !== undefined) {
    out += `\n<description>${toJinjaTrimmedString(paramFields.description)}</description>`;
  }

  out += renderExtraKeys(paramFieldsRaw, ["name", "type", "description"]);
  out += "\n</parameter>";
  return out;
}

function renderTool(tool: Qwen3CoderToolShape): string {
  let out = `\n<function>\n<name>${toJinjaString(tool.name)}</name>`;

  if (tool.description !== undefined) {
    out += `\n<description>${toJinjaTrimmedString(tool.description)}</description>`;
  }

  out += "\n<parameters>";

  const parameters = tool.parameters;
  if (isMapping(parameters) && isMapping((parameters as Mapping).properties)) {
    for (const [paramName, paramFieldsRaw] of Object.entries(
      (parameters as Mapping).properties as Mapping
    )) {
      out += renderParameter(paramName, paramFieldsRaw);
    }
  }

  out += renderExtraKeys(parameters, ["type", "properties"]);
  out += "\n</parameters>";
  out += renderExtraKeys(tool, ["type", "name", "description", "parameters"]);
  out += "\n</function>";
  return out;
}

export function qwen3coderSystemPromptTemplate(
  tools: LanguageModelV3FunctionTool[]
): string {
  if (!tools.length) {
    return "";
  }

  let out = `${QWEN3CODER_TOOL_HEADER}<tools>`;
  for (const tool of tools) {
    out += renderTool(normalizeTool(tool));
  }
  out += "\n</tools>";
  out += QWEN3CODER_TOOL_CALL_INSTRUCTIONS;
  return out;
}

export interface Qwen3CoderToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
}

function stringifyToolResponseContent(value: JSONValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function formatToolResponseAsQwen3CoderXmlWithOptions(
  toolResult: ToolResultPart,
  options?: Qwen3CoderToolResponseFormatterOptions
): string {
  const unwrappedResult = unwrapToolResult(
    toolResult.output,
    options?.mediaStrategy
  );
  const content = stringifyToolResponseContent(unwrappedResult);
  return `<tool_response>\n${content}\n</tool_response>`;
}

export function createQwen3CoderXmlToolResponseFormatter(
  options?: Qwen3CoderToolResponseFormatterOptions
): (toolResult: ToolResultPart) => string {
  return (toolResult) =>
    formatToolResponseAsQwen3CoderXmlWithOptions(toolResult, options);
}

export function formatToolResponseAsQwen3CoderXml(
  toolResult: ToolResultPart
): string {
  return formatToolResponseAsQwen3CoderXmlWithOptions(toolResult);
}

export function qwen3coderAssistantToolCallsToTextContent(options: {
  content: LanguageModelV3Content[];
  protocol: TCMCoreProtocol;
  conversionOptions?: AssistantToolCallTextConversionOptions;
}): LanguageModelV3Content[] {
  return assistantToolCallsToTextContent(options);
}
