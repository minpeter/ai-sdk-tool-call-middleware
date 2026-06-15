import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { coerceBySchema, unwrapJsonSchema } from "../../schema-coerce";

type ToolCallLike = Extract<
  LanguageModelV3Content | LanguageModelV3StreamPart,
  { type: "tool-call" }
>;

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
  tools: LanguageModelV3FunctionTool[]
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
  return JSON.stringify(coerced ?? {});
}

export function coerceToolCallPart<T extends ToolCallLike>(
  part: T,
  tools: LanguageModelV3FunctionTool[]
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
