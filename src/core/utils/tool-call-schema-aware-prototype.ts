import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaRecord,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
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
  readonly schema: ToolInputSchemaDefinition | undefined;
  readonly value: RxmlValue;
}

type TraversalAction = "sensitive" | "skip" | "visit";

function isRxmlRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonDocumentString(value: string): RxmlValue | null {
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
    const parsed: RxmlValue = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function jsonDocumentEntryIsUnsafe(key: string, value: RxmlValue): boolean {
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

function jsonDocumentHasUnsafeStructuredValue(value: RxmlValue): boolean {
  const stack: RxmlValue[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRxmlRecord(current)) {
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

function arrayItemSchema(
  schema: ToolInputSchemaDefinition | undefined,
  index: number
): ToolInputSchemaDefinition | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!(typeof unwrapped === "object" && isSchemaRecord(unwrapped))) {
    return;
  }
  if (
    Array.isArray(unwrapped.prefixItems) &&
    index < unwrapped.prefixItems.length
  ) {
    return unwrapped.prefixItems[index];
  }
  return Array.isArray(unwrapped.items) ? undefined : unwrapped.items;
}

function schemaAwareStringIsPrototypeSensitive(
  value: string,
  schema: ToolInputSchemaDefinition | undefined
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

function traversalAction(
  frame: SchemaAwarePrototypeTraversalFrame,
  seen: Set<object>
): TraversalAction {
  if (typeof frame.value === "string") {
    return schemaAwareStringIsPrototypeSensitive(frame.value, frame.schema)
      ? "sensitive"
      : "skip";
  }
  return frame.value !== null &&
    typeof frame.value === "object" &&
    !seen.has(frame.value)
    ? "visit"
    : "skip";
}

function enqueueChildren(
  stack: SchemaAwarePrototypeTraversalFrame[],
  frame: SchemaAwarePrototypeTraversalFrame
): void {
  if (Array.isArray(frame.value)) {
    for (const [index, item] of frame.value.entries()) {
      stack.push({ schema: arrayItemSchema(frame.schema, index), value: item });
    }
    return;
  }
  if (!isRxmlRecord(frame.value)) {
    return;
  }
  for (const [key, item] of Object.entries(frame.value)) {
    stack.push({
      schema: getToolInputPropertySchema(
        frame.schema ?? true,
        key,
        frame.value
      ),
      value: item,
    });
  }
}

export function toolCallInputHasSchemaAwarePrototypeSensitiveValue(
  value: RxmlValue,
  schema: ToolInputSchemaDefinition | undefined
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
    const frame = stack.pop();
    if (frame === undefined) {
      continue;
    }
    const action = traversalAction(frame, seen);
    if (action === "sensitive") {
      return true;
    }
    if (
      action === "skip" ||
      typeof frame.value !== "object" ||
      frame.value === null
    ) {
      continue;
    }
    seen.add(frame.value);
    enqueueChildren(stack, frame);
    if (stack.length > MAX_SCHEMA_AWARE_PROTOTYPE_TRAVERSAL_WORK) {
      return true;
    }
  }
  return false;
}
