import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { coerceBySchema, unwrapJsonSchema } from "../../schema-coerce";

type ToolCallLike = Extract<
  LanguageModelV4Content | LanguageModelV4StreamPart,
  { type: "tool-call" }
>;

const PROTOTYPE_SENSITIVE_ARGUMENT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasPrototypeSensitiveStructuralKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)) {
        return true;
      }
      stack.push(current[key]);
    }
  }

  return false;
}

function getDeclaredToolInputPropertyNames(
  schema: unknown
): Set<string> | null {
  const unwrapped = unwrapJsonSchema(schema);
  if (!(isRecord(unwrapped) && isRecord(unwrapped.properties))) {
    return null;
  }

  const propertyNames = Object.entries(unwrapped.properties).flatMap(
    ([key, propertySchema]) =>
      propertySchema !== false && !PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)
        ? [key]
        : []
  );
  const requiredNames = Array.isArray(unwrapped.required)
    ? unwrapped.required.filter(
        (key): key is string =>
          typeof key === "string" && !PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)
      )
    : [];
  const names = [...propertyNames, ...requiredNames];
  return names.length > 0 ? new Set(names) : null;
}

export function sanitizeToolCallArgsBySchema(
  args: unknown,
  schema: unknown
): unknown {
  const propertyNames = getDeclaredToolInputPropertyNames(schema);
  if (!(propertyNames && isRecord(args))) {
    return args;
  }

  const sanitized: Record<string, unknown> = {};
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
  const coerced = coerceBySchema(args, schema);
  if (coerced === null) {
    return schemaAllowsNull(schema) ? "null" : undefined;
  }
  const sanitized = sanitizeToolCallArgsBySchema(coerced ?? {}, schema);
  if (hasPrototypeSensitiveStructuralKey(sanitized)) {
    return;
  }
  return JSON.stringify(sanitized);
}

export function coerceToolCallPart<T extends ToolCallLike>(
  part: T,
  tools: LanguageModelV4FunctionTool[]
): T {
  const coercedInput = coerceToolCallInput(part.toolName, part.input, tools);
  if (coercedInput === undefined) {
    return part;
  }

  return {
    ...part,
    input: coercedInput,
  };
}
