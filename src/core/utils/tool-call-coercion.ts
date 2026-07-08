import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { coerceBySchema, unwrapJsonSchema } from "../../schema-coerce";
import { toolCallInputHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";
import { sanitizeToolCallArgsBySchema } from "./tool-call-schema-sanitization";

type ToolCallLike = Extract<
  LanguageModelV4Content | LanguageModelV4StreamPart,
  { type: "tool-call" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (toolCallInputHasPrototypeSensitiveKey(args)) {
    return;
  }
  const coerced = coerceBySchema(args, schema);
  if (coerced === null) {
    return schemaAllowsNull(schema) ? "null" : undefined;
  }
  const sanitized = sanitizeToolCallArgsBySchema(coerced ?? {}, schema);
  if (toolCallInputHasPrototypeSensitiveKey(sanitized)) {
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
