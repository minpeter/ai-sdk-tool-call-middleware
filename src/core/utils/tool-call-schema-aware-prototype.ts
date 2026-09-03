import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import {
  hasPrototypeSensitiveStructuralKey,
  toolCallInputHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";
import { getToolInputPropertySchema } from "./tool-call-object-schema";

const SAFE_PROTOTYPE_LABEL_SCALAR_RE =
  /^\s*(?:constructor|prototype)\s*:\s*(?![[{"'])(?![^\r\n]*\b[A-Za-z0-9_.-]+\s*:)[^\r\n]+$/i;
const MAX_SCHEMA_AWARE_PROTOTYPE_TRAVERSAL_WORK = 100_000;

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

interface SchemaAwarePrototypeTraversalFrame<Value, Schema> {
  readonly schema: Schema | SchemaBoundaryValue;
  readonly value: Value | SchemaBoundaryValue;
}

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
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
    const parsed: SchemaBoundaryValue = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function jsonDocumentEntryIsUnsafe<Value>(key: string, value: Value): boolean {
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
  const stack: SchemaBoundaryValue[] = [value];
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

function arrayItemSchema<Schema>(
  schema: Schema | SchemaBoundaryValue,
  index: number
): SchemaBoundaryValue {
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

function schemaAwareStringIsPrototypeSensitive<Schema>(
  value: string,
  schema: Schema | SchemaBoundaryValue
): boolean {
  if (
    getSchemaType(schema) === "string" &&
    (isSafeJsonDocumentString(value) ||
      SAFE_PROTOTYPE_LABEL_SCALAR_RE.test(value))
  ) {
    return false;
  }
  return toolCallInputHasPrototypeSensitiveKey(value);
}

export function toolCallInputHasSchemaAwarePrototypeSensitiveValue<
  Schema,
  Value,
>(value: Value, schema: Schema): boolean {
  if (hasPrototypeSensitiveStructuralKey(value)) {
    return true;
  }

  const seen = new Set<object>();
  const stack: SchemaAwarePrototypeTraversalFrame<Value, Schema>[] = [
    { schema, value },
  ];
  for (let work = 0; stack.length > 0; work += 1) {
    if (work >= MAX_SCHEMA_AWARE_PROTOTYPE_TRAVERSAL_WORK) {
      return true;
    }
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (typeof current.value === "string") {
      if (
        schemaAwareStringIsPrototypeSensitive(current.value, current.schema)
      ) {
        return true;
      }
      continue;
    }
    if (
      current.value === null ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);

    const children = Array.isArray(current.value)
      ? Array.from(current.value.entries(), ([index, item]) => ({
          schema: arrayItemSchema(current.schema, index),
          value: item,
        }))
      : Object.entries(current.value).map(([key, item]) => ({
          schema: getToolInputPropertySchema(
            current.schema,
            key,
            current.value
          ),
          value: item,
        }));
    if (
      stack.length + children.length >
      MAX_SCHEMA_AWARE_PROTOTYPE_TRAVERSAL_WORK
    ) {
      return true;
    }
    stack.push(...children);
  }

  return false;
}
