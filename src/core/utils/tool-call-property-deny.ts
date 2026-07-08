import { unwrapJsonSchema } from "../../schema-coerce";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addName(names: Set<string>, key: unknown): void {
  if (typeof key === "string") {
    names.add(key);
  }
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

export function collectFalsePropertyNames(
  schema: Record<string, unknown>
): Set<string> {
  const names = new Set<string>();
  if (Object.hasOwn(schema, "properties") && isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema === false) {
        addName(names, key);
      }
    }
  }
  return names;
}

function collectDeniedPropertyNames(
  schema: unknown,
  seen: Set<object>
): Set<string> {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return new Set();
  }
  seen.add(unwrapped);
  return collectAllOfDeniedPropertyNames(unwrapped, seen);
}

export function collectAllOfDeniedPropertyNames(
  schema: Record<string, unknown>,
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
