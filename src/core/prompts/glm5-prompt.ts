import type { JSONValue, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { formatToolResponseWithMedia } from "./shared/tool-response-with-media";
import type { ToolResponseMediaStrategy } from "./shared/tool-result-normalizer";
import type { ToolResponsePromptTemplateResult } from "./shared/tool-result-user-content";

/**
 * Source of truth for the GLM-5.2 tool grammar.
 *
 * https://huggingface.co/zai-org/GLM-5.2/blob/b4734de4facf877f85769a911abafc5283eab3d9/chat_template.jinja
 */
export const GLM5_CHAT_TEMPLATE_REVISION =
  "b4734de4facf877f85769a911abafc5283eab3d9";

/** SHA-256 of the pinned `chat_template.jinja` bytes. */
export const GLM5_CHAT_TEMPLATE_SHA256 =
  "172dc74a35e1752df75ecfb2b2cf9326d2852bb1379868ebeec9571654489679";

const GLM5_TOOL_HEADER = `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>`;

const GLM5_TOOL_FOOTER = `</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value><arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>`;

interface Glm5ToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
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

/** Render the same function object emitted by GLM-5.2's Jinja template. */
export function renderGlm5ToolDefinition(
  tool: LanguageModelV4FunctionTool
): string {
  const definition: Record<string, unknown> = {
    name: tool.name,
  };
  if (tool.description !== undefined) {
    definition.description = tool.description;
  }
  definition.parameters = normalizeInputSchema(tool.inputSchema);
  return JSON.stringify(definition);
}

/**
 * Reproduces the tool section of the official GLM-5.2 chat template without
 * adding competing examples or an alternate protocol dialect.
 */
export function glm5SystemPromptTemplate(
  tools: LanguageModelV4FunctionTool[]
): string {
  if (tools.length === 0) {
    return "";
  }
  const definitions = tools.map(renderGlm5ToolDefinition).join("\n");
  return `${GLM5_TOOL_HEADER}\n${definitions}\n${GLM5_TOOL_FOOTER}`;
}

function stringifyToolResponseContent(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatToolResponseAsGlm5WithOptions(
  toolResult: ToolResultPart,
  options?: Glm5ToolResponseFormatterOptions
): ToolResponsePromptTemplateResult {
  return formatToolResponseWithMedia({
    toolResult,
    mediaStrategy: options?.mediaStrategy,
    wrapContent: (content) =>
      `<tool_response>${stringifyToolResponseContent(content)}</tool_response>`,
  });
}

export function createGlm5ToolResponseFormatter(
  options?: Glm5ToolResponseFormatterOptions
): (toolResult: ToolResultPart) => ToolResponsePromptTemplateResult {
  return (toolResult) =>
    formatToolResponseAsGlm5WithOptions(toolResult, options);
}

export function formatToolResponseAsGlm5(
  toolResult: ToolResultPart
): ToolResponsePromptTemplateResult {
  return formatToolResponseAsGlm5WithOptions(toolResult);
}
