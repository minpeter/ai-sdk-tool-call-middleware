import {
  isJSONObject,
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import dedent from "dedent";
import { stringify } from "../../rxml";
import { escapeXmlMinimalText } from "../../rxml/utils/helpers";
import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaCandidate,
} from "../../schema/tool-input-schema";
import {
  renderInputExamplesSection,
  safeStringifyInputExample,
} from "./shared/input-examples";
import { formatToolResponseWithMedia } from "./shared/tool-response-with-media";
import type { ToolResponseMediaStrategy } from "./shared/tool-result-normalizer";
import type { ToolResponsePromptTemplateResult } from "./shared/tool-result-user-content";

export function morphXmlSystemPromptTemplate(
  tools: LanguageModelV4FunctionTool[]
): string {
  const toolsText = renderToolsForXmlPrompt(tools);
  const inputExamplesText = renderInputExamplesForXmlPrompt(tools);

  const header = dedent`
    # Tools
    You may call one or more functions to assist with the user query.
  `;

  const definitions = [
    "You have access to the following functions:",
    "<tools>",
    toolsText,
    "</tools>",
  ].join("\n");

  const rules = dedent`
    <rules>
    - Use exactly one XML element whose tag name is the function name.
    - Put each parameter as a child element.
    - Values must follow the schema exactly (numbers, arrays, objects, enums -> copy as-is).
    - Do not add or remove functions or parameters.
    - Each required parameter must appear once.
    - Output nothing before or after the function call.
    - It is also possible to call multiple types of functions in one turn or to call a single function multiple times.
    </rules>
  `;

  const examples = dedent`
    For each function call, output the function name and parameter in the following format:
    <example_function_name>
      <example_parameter_1>value_1</example_parameter_1>
      <example_parameter_2>This is the value for the second parameter
    that can span
    multiple lines</example_parameter_2>
    </example_function_name>
  `;

  return [header, definitions, rules, examples, inputExamplesText]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
}

const INDENT = "  ";

function renderToolsForXmlPrompt(tools: LanguageModelV4FunctionTool[]): string {
  if (!tools.length) {
    return "none";
  }

  return tools.map(renderToolForXmlPrompt).join("\n\n");
}

function renderToolForXmlPrompt(tool: LanguageModelV4FunctionTool): string {
  const lines: string[] = [`name: ${tool.name}`];

  if (tool.description) {
    lines.push(`description: ${tool.description}`);
  }

  lines.push("parameters:");
  const normalizedSchema = normalizeSchema(tool.inputSchema);
  lines.push(...renderParametersSummary(normalizedSchema, 1));
  lines.push(`schema: ${stringifySchema(normalizedSchema)}`);

  return lines.join("\n");
}

function renderMorphXmlInputExample(
  toolName: string,
  input: JSONValue
): string {
  try {
    return stringify(toolName, input, {
      suppressEmptyNode: false,
      format: true,
      minimalEscaping: true,
    });
  } catch (error) {
    const fallbackContent = safeStringifyInputExample(input, error);
    const escapedFallback = escapeXmlMinimalText(fallbackContent);
    return `<${toolName}>${escapedFallback}</${toolName}>`;
  }
}

function renderInputExamplesForXmlPrompt(
  tools: LanguageModelV4FunctionTool[]
): string {
  return renderInputExamplesSection({
    tools,
    renderExample: (toolName, input) =>
      isJSONValue(input)
        ? renderMorphXmlInputExample(toolName, input)
        : `<${toolName}>${escapeXmlMinimalText(
            safeStringifyInputExample(input)
          )}</${toolName}>`,
  });
}

function normalizeSchema(
  schema: LanguageModelV4FunctionTool["inputSchema"] | string | undefined
): ToolInputSchemaCandidate {
  if (typeof schema === "string") {
    try {
      const parsed: ToolInputSchemaCandidate = JSON.parse(schema);
      return typeof parsed === "object" && isSchemaRecord(parsed)
        ? parsed
        : ({ type: "string", const: schema } satisfies ToolInputSchema);
    } catch {
      return { type: "string", const: schema } satisfies ToolInputSchema;
    }
  }

  return schema;
}

function renderParametersSummary(
  schema: ToolInputSchemaCandidate,
  indentLevel: number
): string[] {
  const indent = INDENT.repeat(indentLevel);

  if (schema === undefined || schema === null) {
    return [`${indent}(none)`];
  }

  if (schema === true) {
    return [`${indent}(any)`];
  }

  if (schema === false) {
    return [`${indent}(no valid parameters)`];
  }

  if (typeof schema !== "object" || !isSchemaRecord(schema)) {
    return [`${indent}- value (${String(schema)})`];
  }

  const schemaType: NonNullable<ToolInputSchema["type"]>[] = [];

  if (Array.isArray(schema.type)) {
    schemaType.push(...schema.type);
  } else if (schema.type) {
    schemaType.push(schema.type);
  }
  const isObjectLike = schemaType.includes("object") || !!schema.properties;

  if (isObjectLike) {
    const properties = schema.properties ?? {};
    const requiredSet = new Set(schema.required ?? []);
    const propertyNames = Object.keys(properties).sort();
    if (propertyNames.length === 0) {
      return [`${indent}(no named parameters)`];
    }

    const lines: string[] = [];
    for (const propName of propertyNames) {
      const propSchema = properties[propName];
      lines.push(
        renderPropertySummaryLine({
          indent,
          propName,
          propSchema,
          required: requiredSet.has(propName),
        })
      );
    }

    return lines.length ? lines : [`${indent}(no parameters)`];
  }

  return [`${indent}- value (${summarizeType(schema)})`];
}

function renderPropertySummaryLine({
  indent,
  propName,
  propSchema,
  required,
}: {
  indent: string;
  propName: string;
  propSchema: ToolInputSchemaCandidate;
  required: boolean;
}): string {
  const typeLabel = summarizeType(propSchema);
  const requiredLabel = required ? "required" : "optional";
  const extras = collectPropertyExtras(propSchema);
  const extraText = extras.length ? ` - ${extras.join("; ")}` : "";

  return `${indent}- ${propName} (${typeLabel}, ${requiredLabel})${extraText}`;
}

function collectPropertyExtras(propSchema: ToolInputSchemaCandidate): string[] {
  if (
    !propSchema ||
    typeof propSchema !== "object" ||
    !isSchemaRecord(propSchema)
  ) {
    return [];
  }

  const extras: string[] = [];

  if (propSchema.enum) {
    extras.push(`enum: ${formatEnumForSummary(propSchema.enum)}`);
  }

  if (propSchema.default !== undefined) {
    extras.push(`default: ${formatValue(propSchema.default)}`);
  }

  if (propSchema.description) {
    extras.push(propSchema.description);
  }

  return extras;
}

function inferSchemaBaseType(schema: ToolInputSchema): string {
  const schemaType = schema.type;

  if (Array.isArray(schemaType) && schemaType.length) {
    return schemaType.join(" | ");
  }
  if (typeof schemaType === "string") {
    return schemaType;
  }
  if (schema.enum) {
    const inferred: string[] = Array.from(
      new Set(schema.enum.map((value) => typeof value))
    );
    if (inferred.length === 1) {
      return inferred[0] ?? "";
    }
    return "any";
  }
  if (schema.const !== undefined) {
    return typeof schema.const;
  }
  return "any";
}

function summarizeType(schema: ToolInputSchemaCandidate): string {
  if (schema === undefined || schema === null) {
    return "unknown";
  }

  if (schema === true) {
    return "any";
  }

  if (schema === false) {
    return "never";
  }

  if (typeof schema !== "object" || !isSchemaRecord(schema)) {
    return String(schema);
  }

  const baseType = inferSchemaBaseType(schema);

  if (baseType === "array" && schema.items) {
    const itemType = Array.isArray(schema.items)
      ? schema.items.map((item) => summarizeType(item)).join(" | ")
      : summarizeType(schema.items);
    return `array<${itemType}>`;
  }

  if (baseType === "string" && schema.format) {
    return `string (${schema.format})`;
  }

  return baseType;
}

const ENUM_MAX_INLINE = 6;
const ENUM_PREVIEW_LIMIT = 5;

function formatEnumForSummary(
  values: NonNullable<ToolInputSchema["enum"]>
): string {
  if (values.length <= ENUM_MAX_INLINE) {
    return formatValue(values);
  }

  const preview = values
    .slice(0, ENUM_PREVIEW_LIMIT)
    .map((value) => formatValue(value));
  return `[${preview.join(", ")}, ... (${values.length} total)]`;
}

function formatValue(value: ToolInputSchema["const"]): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(formatValue).join(", ")}]`;
  }

  return JSON.stringify(value) ?? "null";
}

function stringifySchema(schema: ToolInputSchemaCandidate): string {
  if (schema === undefined) {
    return "null";
  }
  if (typeof schema !== "object" || schema === null) {
    return JSON.stringify(schema) ?? "null";
  }

  const copied: ToolInputSchemaCandidate = JSON.parse(JSON.stringify(schema));
  return isJSONObject(copied)
    ? JSON.stringify(stripSchemaKeys(copied))
    : (JSON.stringify(schema) ?? "null");
}

function stripSchemaKeys(value: JSONValue): JSONValue;
function stripSchemaKeys(value: undefined): undefined;
function stripSchemaKeys(value: JSONValue | undefined): JSONValue | undefined;
function stripSchemaKeys(value: JSONValue | undefined): JSONValue | undefined {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSchemaKeys(entry));
  }

  if (value && typeof value === "object") {
    const cleaned: JSONObject = {};

    for (const [key, entry] of Object.entries(value)) {
      if (key === "$schema") {
        continue;
      }
      cleaned[key] = stripSchemaKeys(entry);
    }

    return cleaned;
  }

  return value;
}

interface MorphXmlToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
}

function formatXmlNode(
  tagName: string,
  value: JSONValue | undefined,
  depth: number
): string[] {
  const indent = "  ".repeat(depth);

  if (value === null || value === undefined) {
    return [`${indent}<${tagName}></${tagName}>`];
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [`${indent}<${tagName}>${String(value)}</${tagName}>`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}<${tagName}></${tagName}>`];
    }
    const lines = [`${indent}<${tagName}>`];
    for (const item of value) {
      lines.push(...formatXmlNode("item", item, depth + 1));
    }
    lines.push(`${indent}</${tagName}>`);
    return lines;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [`${indent}<${tagName}></${tagName}>`];
  }

  const lines = [`${indent}<${tagName}>`];
  for (const [key, entryValue] of entries) {
    lines.push(...formatXmlNode(key, entryValue, depth + 1));
  }
  lines.push(`${indent}</${tagName}>`);
  return lines;
}

function morphFormatToolResponseAsXmlWithOptions(
  toolResult: ToolResultPart,
  options?: MorphXmlToolResponseFormatterOptions
): ToolResponsePromptTemplateResult {
  return formatToolResponseWithMedia({
    toolResult,
    mediaStrategy: options?.mediaStrategy,
    wrapContent: (content) => {
      const toolNameXml = `<tool_name>${toolResult.toolName}</tool_name>`;
      const resultLines = formatXmlNode("result", content, 1);
      return [
        "<tool_response>",
        `  ${toolNameXml}`,
        ...resultLines,
        "</tool_response>",
      ].join("\n");
    },
  });
}

export function createMorphXmlToolResponseFormatter(
  options?: MorphXmlToolResponseFormatterOptions
): (toolResult: ToolResultPart) => ToolResponsePromptTemplateResult {
  return (toolResult) =>
    morphFormatToolResponseAsXmlWithOptions(toolResult, options);
}

export function morphFormatToolResponseAsXml(
  toolResult: ToolResultPart
): ToolResponsePromptTemplateResult {
  return morphFormatToolResponseAsXmlWithOptions(toolResult);
}
