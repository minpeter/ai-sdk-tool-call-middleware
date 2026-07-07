import { getArrayItemSchema } from "./tool-call-array-schema";
import {
  getToolInputPropertyNames,
  getToolInputPropertySchema,
} from "./tool-call-object-schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolCallArrayBySchema(
  values: readonly unknown[],
  schema: unknown,
  seen: WeakSet<object>
): unknown[] {
  return values.map((value, index) => {
    const itemSchema = getArrayItemSchema(schema, index);
    if (itemSchema === undefined) {
      return value;
    }
    return sanitizeToolCallValueBySchema(value, itemSchema, seen);
  });
}

function sanitizeToolCallObjectBySchema(
  value: Record<string, unknown>,
  schema: unknown,
  propertyNames: Set<string>,
  seen: WeakSet<object>
): Record<string, unknown> {
  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (propertyNames.has(key)) {
      sanitized[key] = sanitizeToolCallValueBySchema(
        nestedValue,
        getToolInputPropertySchema(schema, key, value),
        seen
      );
    }
  }
  return sanitized;
}

function sanitizeToolCallValueBySchema(
  value: unknown,
  schema: unknown,
  seen: WeakSet<object>
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    return sanitizeToolCallArrayBySchema(value, schema, seen);
  }

  const propertyNames = getToolInputPropertyNames(schema, value);
  if (!(propertyNames && isRecord(value))) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  return sanitizeToolCallObjectBySchema(value, schema, propertyNames, seen);
}

export function sanitizeToolCallArgsBySchema(
  args: unknown,
  schema: unknown
): unknown {
  return sanitizeToolCallValueBySchema(args, schema, new WeakSet());
}
