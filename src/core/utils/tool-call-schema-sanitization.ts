import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaDefinition,
  type ToolInputSchemaCandidate,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { getArrayItemSchema } from "./tool-call-array-schema";
import {
  getToolInputPropertyNames,
  getToolInputPropertySchema,
} from "./tool-call-object-schema";

type RxmlRecord = Record<string, RxmlValue>;

function isRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolCallArrayBySchema(
  values: readonly RxmlValue[],
  schema: ToolInputSchemaDefinition,
  seen: WeakSet<object>
): RxmlValue[] {
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

function sanitizeToolCallObjectBySchema(
  value: RxmlRecord,
  schema: ToolInputSchemaDefinition,
  propertyNames: Set<string>,
  seen: WeakSet<object>
): RxmlRecord {
  const sanitized: RxmlRecord = Object.create(null);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (propertyNames.has(key)) {
      const propertySchema = getToolInputPropertySchema(schema, key, value);
      if (propertySchema === false) {
        continue;
      }
      sanitized[key] =
        propertySchema === undefined
          ? nestedValue
          : sanitizeToolCallValueBySchema(nestedValue, propertySchema, seen);
    }
  }
  return sanitized;
}

function sanitizeToolCallValueBySchema(
  value: RxmlValue,
  schema: ToolInputSchemaDefinition,
  seen: WeakSet<object>
): RxmlValue {
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
  args: RxmlValue,
  schema: ToolInputSchemaCandidate
): RxmlValue {
  return isSchemaDefinition(schema)
    ? sanitizeToolCallValueBySchema(args, schema, new WeakSet())
    : args;
}
