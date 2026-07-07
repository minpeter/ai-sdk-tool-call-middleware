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
const PROTOTYPE_SENSITIVE_JSON_KEY_TEXT_REGEX =
  /["'](?:__proto__|constructor|prototype)["']\s*:|[{,]\s*(?:__proto__|constructor|prototype)\s*:/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markUnseen(value: object, seen: Set<object>): boolean {
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  return true;
}

function enqueueArrayItems(
  value: unknown,
  seen: Set<object>,
  stack: unknown[]
): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  if (markUnseen(value, seen)) {
    stack.push(...value);
  }
  return true;
}

function hasUnsafePrototype(record: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(record);
  return prototype !== null && prototype !== Object.prototype;
}

function enqueueRecordOwnValues(
  record: Record<string, unknown>,
  stack: unknown[]
): boolean {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && "value" in descriptor) {
      stack.push(descriptor.value);
    }
  }
  return false;
}

export function hasPrototypeSensitiveStructuralKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (enqueueArrayItems(current, seen, stack)) {
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (!markUnseen(current, seen)) {
      continue;
    }
    if (hasUnsafePrototype(current)) {
      return true;
    }
    if (enqueueRecordOwnValues(current, stack)) {
      return true;
    }
  }

  return false;
}

function toolCallInputHasPrototypeSensitiveKey(input: unknown): boolean {
  if (typeof input !== "string") {
    return hasPrototypeSensitiveStructuralKey(input);
  }
  try {
    return hasPrototypeSensitiveStructuralKey(JSON.parse(input));
  } catch {
    return PROTOTYPE_SENSITIVE_JSON_KEY_TEXT_REGEX.test(input);
  }
}

function getDeclaredToolInputPropertyNames(
  schema: unknown
): Set<string> | null {
  return collectDeclaredToolInputPropertyNames(schema, new Set());
}

function addSafePropertyName(names: Set<string>, key: unknown): void {
  if (typeof key === "string" && !PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)) {
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
  const combinatorNames = collectCombinatorDeclaredPropertyNames(
    unwrapped,
    seen
  );
  if (combinatorNames) {
    addNames(names, combinatorNames);
  }

  if (
    names.size === 0 &&
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
  return JSON.stringify(sanitized);
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
    return part;
  }

  return {
    ...part,
    input: coercedInput,
  };
}
