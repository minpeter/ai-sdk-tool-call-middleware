import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import dedent from "dedent";
import {
  type ToolResponseMediaStrategy,
  unwrapToolResult,
} from "./shared/tool-result-normalizer";

export function morphXmlSystemPromptTemplate(
  tools: LanguageModelV3FunctionTool[]
): string {
  const toolsText = renderToolsForXmlPrompt(tools);

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
    - Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
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

  return [header, definitions, rules, examples].join("\n\n");
}

const INDENT = "  ";

function renderToolsForXmlPrompt(tools: LanguageModelV3FunctionTool[]): string {
  if (!tools.length) {
    return "none";
  }

  return tools.map(renderToolForXmlPrompt).join("\n\n");
}

function renderToolForXmlPrompt(tool: LanguageModelV3FunctionTool): string {
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

function normalizeSchema(
  schema: JSONSchema7 | boolean | string | undefined
): JSONSchema7 | boolean | undefined {
  if (typeof schema === "string") {
    try {
      return JSON.parse(schema) as JSONSchema7;
    } catch {
      return { type: "string", const: schema };
    }
  }

  return schema;
}

function renderParametersSummary(
  schema: JSONSchema7 | boolean | undefined,
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

  if (typeof schema !== "object") {
    return [`${indent}- value (${String(schema)})`];
  }

  const schemaType: NonNullable<JSONSchema7["type"]>[] = [];

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
      const propSchema = properties[propName] as
        | JSONSchema7
        | boolean
        | undefined;
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
  propSchema: JSONSchema7 | boolean | undefined;
  required: boolean;
}): string {
  const typeLabel = summarizeType(propSchema);
  const requiredLabel = required ? "required" : "optional";
  const extras = collectPropertyExtras(propSchema);
  const extraText = extras.length ? ` - ${extras.join("; ")}` : "";

  return `${indent}- ${propName} (${typeLabel}, ${requiredLabel})${extraText}`;
}

function collectPropertyExtras(
  propSchema: JSONSchema7 | boolean | undefined
): string[] {
  if (!propSchema || typeof propSchema !== "object") {
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

function summarizeType(schema: JSONSchema7 | boolean | undefined): string {
  if (schema === undefined || schema === null) {
    return "unknown";
  }

  if (schema === true) {
    return "any";
  }

  if (schema === false) {
    return "never";
  }

  if (typeof schema !== "object") {
    return String(schema);
  }

  const schemaType = schema.type;
  let baseType = "";

  if (Array.isArray(schemaType) && schemaType.length) {
    baseType = schemaType.join(" | ");
  } else if (typeof schemaType === "string") {
    baseType = schemaType;
  } else if (schema.enum) {
    const inferred: string[] = Array.from(
      new Set(schema.enum.map((value: unknown) => typeof value))
    );
    if (inferred.length === 1) {
      baseType = inferred[0] ?? "";
    }
  } else if (schema.const !== undefined) {
    baseType = typeof schema.const;
  }

  if (!baseType) {
    baseType = "any";
  }

  if (baseType === "array" && schema.items) {
    const itemType = Array.isArray(schema.items)
      ? schema.items
          .map((item: JSONSchema7 | boolean) => summarizeType(item))
          .join(" | ")
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

function formatEnumForSummary(values: unknown[]): string {
  if (values.length <= ENUM_MAX_INLINE) {
    return formatValue(values);
  }

  const preview = values
    .slice(0, ENUM_PREVIEW_LIMIT)
    .map((value) => formatValue(value));
  return `[${preview.join(", ")}, ... (${values.length} total)]`;
}

function formatValue(value: unknown): string {
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

  return JSON.stringify(value);
}

function stringifySchema(schema: JSONSchema7 | boolean | undefined): string {
  if (schema === undefined) {
    return "null";
  }

  return JSON.stringify(stripSchemaKeys(schema));
}

function stripSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSchemaKeys(entry));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(record)) {
      if (key === "$schema") {
        continue;
      }
      cleaned[key] = stripSchemaKeys(entry);
    }

    return cleaned;
  }

  return value;
}

export interface MorphXmlToolResponseFormatterOptions {
  mediaStrategy?: ToolResponseMediaStrategy;
}

function formatXmlNode(
  tagName: string,
  value: JSONValue,
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
      lines.push(...formatXmlNode("item", item as JSONValue, depth + 1));
    }
    lines.push(`${indent}</${tagName}>`);
    return lines;
  }

  const entries = Object.entries(value as Record<string, JSONValue>);
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
): string {
  const unwrappedResult = unwrapToolResult(
    toolResult.output,
    options?.mediaStrategy
  );
  const toolNameXml = `<tool_name>${toolResult.toolName}</tool_name>`;
  const resultLines = formatXmlNode("result", unwrappedResult, 1);

  return [
    "<tool_response>",
    `  ${toolNameXml}`,
    ...resultLines,
    "</tool_response>",
  ].join("\n");
}

export function createMorphXmlToolResponseFormatter(
  options?: MorphXmlToolResponseFormatterOptions
): (toolResult: ToolResultPart) => string {
  return (toolResult) =>
    morphFormatToolResponseAsXmlWithOptions(toolResult, options);
}

export function morphFormatToolResponseAsXml(
  toolResult: ToolResultPart
): string {
  return morphFormatToolResponseAsXmlWithOptions(toolResult);
}
