import { unwrapJsonSchema } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";

const JSON_SCHEMA_COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDeclaredToolInputPropertyNames(
  schema: unknown
): Set<string> | null {
  return collectDeclaredToolInputPropertyNames(schema, new Set());
}

function addSafePropertyName(names: Set<string>, key: unknown): void {
  if (typeof key === "string" && !isPrototypeSensitiveArgumentKey(key)) {
    names.add(key);
  }
}

function collectDirectDeclaredPropertyNames(
  schema: Record<string, unknown>
): Set<string> {
  const names = new Set<string>();
  if (Object.hasOwn(schema, "properties") && isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema !== false) {
        addSafePropertyName(names, key);
      }
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      addSafePropertyName(names, key);
    }
  }
  return names;
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function collectCombinatorDeclaredPropertyNames(
  schema: Record<string, unknown>,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  for (const combinator of JSON_SCHEMA_COMBINATORS) {
    const variants = schema[combinator];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const nestedNames = collectDeclaredToolInputPropertyNames(
        variant,
        new Set(seen)
      );
      if (nestedNames) {
        found = true;
        addNames(names, nestedNames);
      }
    }
  }
  return found ? names : null;
}

function collectDeclaredToolInputPropertyNames(
  schema: unknown,
  seen: Set<object>
): Set<string> | null {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return null;
  }
  seen.add(unwrapped);

  const names = collectDirectDeclaredPropertyNames(unwrapped);
  const hasDirectProperties =
    Object.hasOwn(unwrapped, "properties") && isRecord(unwrapped.properties);
  const hasStrictPatternProperties =
    Object.hasOwn(unwrapped, "patternProperties") &&
    isRecord(unwrapped.patternProperties) &&
    unwrapped.additionalProperties === false;
  const combinatorNames = collectCombinatorDeclaredPropertyNames(
    unwrapped,
    seen
  );
  if (combinatorNames) {
    addNames(names, combinatorNames);
  }

  if (
    names.size === 0 &&
    !hasDirectProperties &&
    !hasStrictPatternProperties &&
    !combinatorNames
  ) {
    return null;
  }
  return names;
}

function collectPropertySchemaFromCombinators(
  schema: Record<string, unknown>,
  key: string,
  seen: Set<object>
): unknown {
  const propertySchemas: unknown[] = [];
  for (const combinator of JSON_SCHEMA_COMBINATORS) {
    const variants = schema[combinator];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const propertySchema = getDeclaredPropertySchema(
        variant,
        key,
        new Set(seen)
      );
      if (propertySchema !== undefined) {
        propertySchemas.push(propertySchema);
      }
    }
  }
  if (propertySchemas.length === 0) {
    return;
  }
  if (propertySchemas.length === 1) {
    return propertySchemas[0];
  }
  return { allOf: propertySchemas };
}

function getDeclaredPropertySchema(
  schema: unknown,
  key: string,
  seen: Set<object>
): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return;
  }
  seen.add(unwrapped);

  if (
    isRecord(unwrapped.properties) &&
    Object.hasOwn(unwrapped.properties, key)
  ) {
    return unwrapped.properties[key];
  }
  return collectPropertySchemaFromCombinators(unwrapped, key, seen);
}

function getDirectPropertySchema(schema: unknown, key: string): unknown {
  return getDeclaredPropertySchema(schema, key, new Set());
}

function getArrayItemSchema(schema: unknown): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped)) {
    return;
  }
  return unwrapped.items;
}

function sanitizeToolCallArrayBySchema(
  values: readonly unknown[],
  schema: unknown,
  seen: WeakSet<object>
): unknown[] {
  const itemSchema = getArrayItemSchema(schema);
  if (itemSchema === undefined) {
    return [...values];
  }
  return values.map((value) =>
    sanitizeToolCallValueBySchema(value, itemSchema, seen)
  );
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

  const propertyNames = getDeclaredToolInputPropertyNames(schema);
  if (!(propertyNames && isRecord(value))) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (propertyNames.has(key)) {
      sanitized[key] = sanitizeToolCallValueBySchema(
        nestedValue,
        getDirectPropertySchema(schema, key),
        seen
      );
    }
  }
  return sanitized;
}

export function sanitizeToolCallArgsBySchema(
  args: unknown,
  schema: unknown
): unknown {
  return sanitizeToolCallValueBySchema(args, schema, new WeakSet());
}
