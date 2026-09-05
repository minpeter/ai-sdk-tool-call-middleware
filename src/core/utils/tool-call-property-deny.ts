import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";

function isToolInputSchema(
  schema: ToolInputSchemaDefinition | undefined
): schema is ToolInputSchema {
  return typeof schema === "object" && isSchemaRecord(schema);
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

export function collectFalsePropertyNames(
  schema: ToolInputSchema
): Set<string> {
  const names = new Set<string>();
  if (Object.hasOwn(schema, "properties") && schema.properties) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema === false) {
        names.add(key);
      }
    }
  }
  return names;
}

function collectDeniedPropertyNames(
  schema: ToolInputSchemaDefinition,
  seen: Set<object>
): Set<string> {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isToolInputSchema(unwrapped) || seen.has(unwrapped)) {
    return new Set();
  }
  seen.add(unwrapped);
  return collectAllOfDeniedPropertyNames(unwrapped, seen);
}

export function collectAllOfDeniedPropertyNames(
  schema: ToolInputSchema,
  seen: Set<object>
): Set<string> {
  const names = collectFalsePropertyNames(schema);
  if (!Array.isArray(schema.allOf)) {
    return names;
  }
  for (const variant of schema.allOf) {
    addNames(names, collectDeniedPropertyNames(variant, new Set(seen)));
  }
  return names;
}
