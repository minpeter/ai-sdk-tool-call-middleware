import type { JSONValue, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
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

const JSON_EXPONENT_RE = /e([+-])(\d+)$/;
// Friendli's renderer canonicalizes schema numbers through Python-style JSON,
// while replayed arguments retain signed/unsigned 64-bit integers before
// falling back to float notation. These are separate byte-level contracts.
const PYTHON_SCIENTIFIC_NOTATION_THRESHOLD = 1e16;
const SCHEMA_LARGE_DECIMAL_THRESHOLD = 1e15;
const SIGNED_64_BIT_LOWER_BOUND = -(2 ** 63);
const UNSIGNED_64_BIT_LIMIT = 2 ** 64;

type Mapping = Record<string, unknown>;
type NativeJsonContext = "history" | "schema";

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

function compareByCodePoint(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const length = Math.min(leftCharacters.length, rightCharacters.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCharacters[index]?.codePointAt(0) ?? -1;
    const rightCodePoint = rightCharacters[index]?.codePointAt(0) ?? -1;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint;
    }
  }
  return leftCharacters.length - rightCharacters.length;
}

function stringifyPythonExponent(value: number): string {
  return value
    .toExponential()
    .replace(
      JSON_EXPONENT_RE,
      (_match, sign: string, exponent: string) =>
        `e${sign}${exponent.padStart(2, "0")}`
    );
}

function stringifyNativeNumber(
  value: number,
  context: NativeJsonContext
): string {
  if (value !== 0 && Math.abs(value) < 0.0001 && Number.isFinite(value)) {
    return stringifyPythonExponent(value);
  }

  const serialized = JSON.stringify(value);
  const absoluteValue = Math.abs(value);
  if (
    context === "schema" &&
    Number.isInteger(value) &&
    absoluteValue >= SCHEMA_LARGE_DECIMAL_THRESHOLD &&
    serialized.endsWith("0")
  ) {
    return absoluteValue < PYTHON_SCIENTIFIC_NOTATION_THRESHOLD
      ? `${serialized}.0`
      : stringifyPythonExponent(value);
  }
  if (
    context === "history" &&
    Number.isInteger(value) &&
    (value <= SIGNED_64_BIT_LOWER_BOUND || value >= UNSIGNED_64_BIT_LIMIT)
  ) {
    return stringifyPythonExponent(value);
  }
  return serialized;
}

function stringifyKExaone2NativeJsonWithContext(
  value: unknown,
  context: NativeJsonContext
): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => stringifyKExaone2NativeJsonWithContext(item, context))
      .join(", ")}]`;
  }

  if (isMapping(value)) {
    const properties = Object.keys(value)
      .sort(compareByCodePoint)
      .flatMap((key) => {
        const property = value[key];
        if (
          property === undefined ||
          typeof property === "function" ||
          typeof property === "symbol"
        ) {
          return [];
        }
        return [
          `${JSON.stringify(key)}: ${stringifyKExaone2NativeJsonWithContext(property, context)}`,
        ];
      });
    return `{${properties.join(", ")}}`;
  }

  if (typeof value === "number") {
    return stringifyNativeNumber(value, context);
  }

  return JSON.stringify(value) ?? "null";
}

export function stringifyKExaone2NativeJson(value: unknown): string {
  return stringifyKExaone2NativeJsonWithContext(value, "history");
}

function renderTool(tool: LanguageModelV4FunctionTool): string {
  const functionProperties = [
    `"name": ${JSON.stringify(tool.name)}`,
    ...(tool.description === undefined
      ? []
      : [`"description": ${JSON.stringify(tool.description)}`]),
    `"parameters": ${stringifyKExaone2NativeJsonWithContext(normalizeInputSchema(tool.inputSchema), "schema")}`,
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

  const declarations = tools.map(renderTool).join("\n");
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
