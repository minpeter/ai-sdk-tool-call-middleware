import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { coerceBySchema, unwrapJsonSchema } from "../../schema-coerce";
import {
  hasPrototypeSensitiveStructuralKey,
  isPrototypeSensitiveArgumentKey,
  toolCallInputHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";

type ToolCallLike = Extract<
  LanguageModelV4Content | LanguageModelV4StreamPart,
  { type: "tool-call" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDeclaredToolInputPropertyNames(
  schema: unknown
): Set<string> | null {
  return collectDeclaredToolInputPropertyNames(schema, new Set());
}

function addSafePropertyName(names: Set<string>, key: unknown): void {
  if (typeof key === "string" && !isPrototypeSensitiveArgumentKey(key)) {
    names.add(key);
  }
}

function collectDirectDeclaredPropertyNames(
  schema: Record<string, unknown>
): Set<string> {
  const names = new Set<string>();
  if (Object.hasOwn(schema, "properties") && isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema !== false) {
        addSafePropertyName(names, key);
      }
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      addSafePropertyName(names, key);
    }
  }
  return names;
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function collectCombinatorDeclaredPropertyNames(
  schema: Record<string, unknown>,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = schema[combinator];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const nestedNames = collectDeclaredToolInputPropertyNames(
        variant,
        new Set(seen)
      );
      if (nestedNames) {
        found = true;
        addNames(names, nestedNames);
      }
    }
  }
  return found ? names : null;
}

function collectDeclaredToolInputPropertyNames(
  schema: unknown,
  seen: Set<object>
): Set<string> | null {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return null;
  }
  seen.add(unwrapped);

  const names = collectDirectDeclaredPropertyNames(unwrapped);
  const hasDirectProperties =
    Object.hasOwn(unwrapped, "properties") && isRecord(unwrapped.properties);
  const combinatorNames = collectCombinatorDeclaredPropertyNames(
    unwrapped,
    seen
  );
  if (combinatorNames) {
    addNames(names, combinatorNames);
  }

  if (
    names.size === 0 &&
    !hasDirectProperties &&
    unwrapped.additionalProperties !== false &&
    !combinatorNames
  ) {
    return null;
  }
  return names;
}

export function sanitizeToolCallArgsBySchema(
  args: unknown,
  schema: unknown
): unknown {
  const propertyNames = getDeclaredToolInputPropertyNames(schema);
  if (!(propertyNames && isRecord(args))) {
    return args;
  }

  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(args)) {
    if (propertyNames.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
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
  if (hasPrototypeSensitiveStructuralKey(args)) {
    return;
  }
  const coerced = coerceBySchema(args, schema);
  if (coerced === null) {
    return schemaAllowsNull(schema) ? "null" : undefined;
  }
  const sanitized = sanitizeToolCallArgsBySchema(coerced ?? {}, schema);
  if (hasPrototypeSensitiveStructuralKey(sanitized)) {
    return;
  }
  return stringifyToolArgs(sanitized);
}

export function coerceToolCallPart<T extends ToolCallLike>(
  part: T,
  tools: LanguageModelV4FunctionTool[]
): T {
  if (toolCallInputHasPrototypeSensitiveKey(part.input)) {
    return {
      ...part,
      input: "{}",
    };
  }

  const coercedInput = coerceToolCallInput(part.toolName, part.input, tools);
  if (coercedInput === undefined) {
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
