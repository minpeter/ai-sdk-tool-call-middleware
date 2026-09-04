import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import type {
  ToolInputSchemaCandidate,
  ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { coerceBySchema, unwrapJsonSchema } from "../../schema-coerce";
import { toolCallInputHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue as inputHasSchemaAwarePrototypeSensitiveValue } from "./tool-call-schema-aware-prototype";
import { sanitizeToolCallArgsBySchema } from "./tool-call-schema-sanitization";

type ToolCallLike = Extract<
  LanguageModelV4Content | LanguageModelV4StreamPart,
  { type: "tool-call" }
>;

type JsonValueFrame =
  | {
      readonly allowUndefined: boolean;
      readonly leaving: false;
      readonly value: RxmlValue;
    }
  | { readonly leaving: true; readonly value: object };

function isJsonPrimitive(
  value: RxmlValue
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isJsonValueBoundary(value: RxmlValue): value is JSONValue {
  const active = new Set<object>();
  const stack: JsonValueFrame[] = [
    { allowUndefined: false, leaving: false, value },
  ];
  while (stack.length > 0) {
    const [frame] = stack.splice(-1, 1);
    if (frame.leaving) {
      active.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (isJsonPrimitive(current)) {
      continue;
    }
    if (current === undefined && frame.allowUndefined) {
      continue;
    }
    if (typeof current !== "object" || active.has(current)) {
      return false;
    }
    active.add(current);
    stack.push({ leaving: true, value: current });
    const allowUndefined = !Array.isArray(current);
    for (const child of Object.values(current)) {
      stack.push({ allowUndefined, leaving: false, value: child });
    }
  }
  return true;
}

export function toolCallInputHasSchemaAwarePrototypeSensitiveValue(
  value: RxmlValue,
  schema: ToolInputSchemaDefinition | undefined
): boolean {
  return inputHasSchemaAwarePrototypeSensitiveValue(value, schema);
}

function schemaAllowsNull(
  schema: ToolInputSchemaCandidate,
  seen = new Set<object>()
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === true) {
    return true;
  }
  if (unwrapped === undefined || typeof unwrapped === "boolean") {
    return false;
  }
  if (seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);

  const schemaType = unwrapped.type;
  if (schemaType === "null") {
    return true;
  }
  if (Array.isArray(schemaType) && schemaType.includes("null")) {
    return true;
  }

  const { allOf, anyOf, oneOf } = unwrapped;
  if (
    allOf?.length &&
    allOf.every((item: ToolInputSchemaDefinition) =>
      schemaAllowsNull(item, new Set(seen))
    )
  ) {
    return true;
  }
  if (
    anyOf?.some((item: ToolInputSchemaDefinition) =>
      schemaAllowsNull(item, new Set(seen))
    )
  ) {
    return true;
  }
  return (
    oneOf?.some((item: ToolInputSchemaDefinition) =>
      schemaAllowsNull(item, new Set(seen))
    ) === true
  );
}

function stringifyToolArgs(value: JSONValue): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    throw error;
  }
}

function parseToolCallInput(input: RxmlValue): JSONValue | undefined {
  if (typeof input !== "string") {
    return isJsonValueBoundary(input) ? input : undefined;
  }
  try {
    const parsed: JSONValue = JSON.parse(input);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return;
    }
    throw error;
  }
}

export function coerceToolCallInput(
  toolName: string,
  input: RxmlValue,
  tools: LanguageModelV4FunctionTool[]
): string | undefined {
  const args = parseToolCallInput(input);
  if (args === undefined) {
    return;
  }

  const schemaCandidate: ToolInputSchemaCandidate = tools.find(
    (tool) => tool.name === toolName
  )?.inputSchema;
  const schema = unwrapJsonSchema(schemaCandidate);
  if (args === null) {
    return schemaAllowsNull(schema) ? "null" : undefined;
  }
  if (toolCallInputHasSchemaAwarePrototypeSensitiveValue(args, schema)) {
    return;
  }
  const coerced = coerceBySchema(args, schema);
  const valueToSanitize: JSONValue = isJsonValueBoundary(coerced)
    ? coerced
    : {};
  const sanitized =
    schema === undefined
      ? valueToSanitize
      : sanitizeToolCallArgsBySchema(valueToSanitize, schema);
  if (
    !isJsonValueBoundary(sanitized) ||
    toolCallInputHasSchemaAwarePrototypeSensitiveValue(sanitized, schema)
  ) {
    return;
  }
  return stringifyToolArgs(sanitized);
}

export function coerceToolCallPart<T extends ToolCallLike>(
  part: T,
  tools: LanguageModelV4FunctionTool[]
): T {
  const inputHasSensitiveStructuredText = toolCallInputHasPrototypeSensitiveKey(
    part.input
  );
  const coercedInput = coerceToolCallInput(part.toolName, part.input, tools);
  if (coercedInput === undefined) {
    if (inputHasSensitiveStructuredText) {
      return {
        ...part,
        input: "{}",
      };
    }
    return part;
  }

  return {
    ...part,
    input: coercedInput,
  };
}
