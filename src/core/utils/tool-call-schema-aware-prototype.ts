import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import {
  hasPrototypeSensitiveStructuralKey,
  toolCallInputHasPrototypeSensitiveKey,
} from "./prototype-sensitive-keys";
import { getToolInputPropertySchema } from "./tool-call-object-schema";

const SAFE_PROTOTYPE_LABEL_SCALAR_RE =
  /^\s*(?:constructor|prototype)\s*:\s*(?![[{"'])(?![^\r\n]*\b[A-Za-z0-9_.-]+\s*:)[^\r\n]+$/i;
const MAX_SCHEMA_AWARE_PROTOTYPE_TRAVERSAL_WORK = 100_000;

interface SchemaAwarePrototypeTraversalFrame {
  readonly schema: unknown;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function jsonDocumentEntryIsUnsafe(key: string, value: unknown): boolean {
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
  const stack: unknown[] = [value];
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

function arrayItemSchema(schema: unknown, index: number): unknown {
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

function schemaAwareStringIsPrototypeSensitive(
  value: string,
  schema: unknown
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

export function toolCallInputHasSchemaAwarePrototypeSensitiveValue(
  value: unknown,
  schema: unknown
): boolean {
  if (hasPrototypeSensitiveStructuralKey(value)) {
    return true;
  }

  const seen = new Set<object>();
  const stack: SchemaAwarePrototypeTraversalFrame[] = [{ schema, value }];
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
