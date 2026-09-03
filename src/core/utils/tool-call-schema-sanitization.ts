import { getArrayItemSchema } from "./tool-call-array-schema";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";
import {
  getToolInputPropertyNames,
  getToolInputPropertySchema,
} from "./tool-call-object-schema";

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolCallArrayBySchema<Schema>(
  values: readonly SchemaBoundaryValue[],
  schema: Schema,
  seen: WeakSet<object>
): SchemaBoundaryValue[] {
  return values.flatMap((value, index) => {
    const itemSchema = getArrayItemSchema(schema, index);
    if (itemSchema === false) {
      return [];
    }
    if (itemSchema === undefined) {
      return [value];
    }
    return [sanitizeToolCallValueBySchema(value, itemSchema, seen)];
  });
}

function sanitizeToolCallObjectBySchema<Schema>(
  value: SchemaBoundaryRecord,
  schema: Schema,
  propertyNames: Set<string>,
  seen: WeakSet<object>
): SchemaBoundaryRecord {
  const sanitized: SchemaBoundaryRecord = Object.create(null);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (propertyNames.has(key)) {
      const propertySchema = getToolInputPropertySchema(schema, key, value);
      if (propertySchema === false) {
        continue;
      }
      sanitized[key] = sanitizeToolCallValueBySchema(
        nestedValue,
        propertySchema,
        seen
      );
    }
  }
  return sanitized;
}

function sanitizeToolCallValueBySchema<Value, Schema>(
  value: Value,
  schema: Schema,
  seen: WeakSet<object>
): Value | SchemaBoundaryValue {
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

export function sanitizeToolCallArgsBySchema<Args, Schema>(
  args: Args,
  schema: Schema
): Args | SchemaBoundaryValue {
  return sanitizeToolCallValueBySchema(args, schema, new WeakSet());
}
