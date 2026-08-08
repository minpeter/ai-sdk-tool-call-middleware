import type { JSONValue, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import {
  renderInputExamplesSection,
  safeStringifyInputExample,
} from "./shared/input-examples";
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

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function renderTool(tool: LanguageModelV4FunctionTool): string {
  return `<tool>${JSON.stringify({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeInputSchema(tool.inputSchema),
    },
  })}</tool>`;
}

function renderParameterValue(value: unknown): string {
  return typeof value === "string" ? value : safeStringifyInputExample(value);
}

function renderKExaone2InputExample(toolName: string, input: unknown): string {
  const entries = isMapping(input) ? Object.entries(input) : [["input", input]];
  const parameters = entries
    .map(
      ([name, value]) =>
        `<parameter=${name}>\n${renderParameterValue(value)}\n</parameter>`
    )
    .join("\n");

  return `<tool_call>\n<function=${toolName}>\n${parameters}\n</function>\n</tool_call>`;
}

export function kExaone2SystemPromptTemplate(
  tools: LanguageModelV4FunctionTool[]
): string {
  if (tools.length === 0) {
    return "";
  }

  const declarations = tools.map(renderTool).join("\n");
  let prompt = `# Tools
The available tools are defined below in JSON format.
When calling a tool, use XML with <function=...> and one <parameter=...> block per argument.

${declarations}

${K_EXAONE_2_TOOL_CALL_FORMAT}`;

  const inputExamples = renderInputExamplesSection({
    tools,
    renderExample: renderKExaone2InputExample,
  });
  if (inputExamples.length > 0) {
    prompt += `\n\n${inputExamples}`;
  }

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
