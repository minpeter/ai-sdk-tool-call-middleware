import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  coerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "../../schema-coerce";
import {
  hasPrototypeSensitiveStructuralKey,
  toolCallInputHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";
import { getToolInputPropertySchema } from "./tool-call-object-schema";
import { sanitizeToolCallArgsBySchema } from "./tool-call-schema-sanitization";

type ToolCallLike = Extract<
  LanguageModelV4Content | LanguageModelV4StreamPart,
  { type: "tool-call" }
>;

const SAFE_PROTOTYPE_LABEL_SCALAR_RE =
  /^\s*(?:constructor|prototype)\s*:\s*(?![[{"'])(?![^\r\n]*\b[A-Za-z0-9_.-]+\s*:)[^\r\n]+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonDocumentString(value: string): object | null {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function jsonDocumentEntryIsUnsafe(key: string, value: unknown): boolean {
  if (key === "__proto__") {
    return true;
  }
  if (
    (key === "constructor" || key === "prototype") &&
    typeof value !== "string"
  ) {
    return true;
  }
  return (
    typeof value === "string" && toolCallInputHasPrototypeSensitiveKey(value)
  );
}

function jsonDocumentHasUnsafeStructuredValue(value: object): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (jsonDocumentEntryIsUnsafe(key, item)) {
        return true;
      }
      if (typeof item === "object" && item !== null) {
        stack.push(item);
      }
    }
  }
  return false;
}

function isSafeJsonDocumentString(value: string): boolean {
  const parsed = parseJsonDocumentString(value);
  return parsed !== null && !jsonDocumentHasUnsafeStructuredValue(parsed);
}

function arrayItemSchema(schema: unknown, index: number): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped)) {
    return;
  }
  if (
    Array.isArray(unwrapped.prefixItems) &&
    index < unwrapped.prefixItems.length
  ) {
    return unwrapped.prefixItems[index];
  }
  return unwrapped.items;
}

export function toolCallInputHasSchemaAwarePrototypeSensitiveValue(
  value: unknown,
  schema: unknown,
  seen = new Set<object>()
): boolean {
  if (typeof value === "string") {
    if (getSchemaType(schema) === "string") {
      if (
        isSafeJsonDocumentString(value) ||
        SAFE_PROTOTYPE_LABEL_SCALAR_RE.test(value)
      ) {
        return false;
      }
      return toolCallInputHasPrototypeSensitiveKey(value);
    }
    return toolCallInputHasPrototypeSensitiveKey(value);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (hasPrototypeSensitiveStructuralKey(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item, index) =>
      toolCallInputHasSchemaAwarePrototypeSensitiveValue(
        item,
        arrayItemSchema(schema, index),
        seen
      )
    );
  }
  return Object.entries(value).some(([key, item]) =>
    toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      item,
      getToolInputPropertySchema(schema, key, value),
      seen
    )
  );
}

function schemaAllowsNull(schema: unknown, seen = new Set<object>()): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === true) {
    return true;
  }
  if (unwrapped === false || !unwrapped || typeof unwrapped !== "object") {
    return false;
  }
  if (Array.isArray(unwrapped)) {
    return false;
  }
  if (seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);

  const record = unwrapped as Record<string, unknown>;
  const schemaType = record.type;
  if (schemaType === "null") {
    return true;
  }
  if (Array.isArray(schemaType) && schemaType.includes("null")) {
    return true;
  }

  const allOf = Array.isArray(record.allOf) ? record.allOf : undefined;
  if (
    allOf?.length &&
    allOf.every((item) => schemaAllowsNull(item, new Set(seen)))
  ) {
    return true;
  }
  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : undefined;
  if (anyOf?.some((item) => schemaAllowsNull(item, new Set(seen)))) {
    return true;
  }
  const oneOf = Array.isArray(record.oneOf) ? record.oneOf : undefined;
  return oneOf?.some((item) => schemaAllowsNull(item, new Set(seen))) === true;
}

function stringifyToolArgs(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    throw error;
  }
}

export function coerceToolCallInput(
  toolName: string,
  input: unknown,
  tools: LanguageModelV4FunctionTool[]
): string | undefined {
  let args: unknown = {};
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
    } catch {
      return;
    }
  } else if (input === null) {
    args = null;
  } else if (input && typeof input === "object") {
    args = input;
  } else {
    return;
  }

  const schema = tools.find((t) => t.name === toolName)?.inputSchema;
  if (args === null) {
    return schemaAllowsNull(schema) ? "null" : undefined;
  }
  if (toolCallInputHasSchemaAwarePrototypeSensitiveValue(args, schema)) {
    return;
  }
  const coerced = coerceBySchema(args, schema);
  if (coerced === null) {
    return schemaAllowsNull(schema) ? "null" : undefined;
  }
  const sanitized = sanitizeToolCallArgsBySchema(coerced ?? {}, schema);
  if (toolCallInputHasSchemaAwarePrototypeSensitiveValue(sanitized, schema)) {
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
    if (isRecord(part.input)) {
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
