import { unwrapJsonSchema } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import {
  collectPatternPropertyNames,
  getPatternPropertySchema,
  hasStrictPatternProperties,
} from "./tool-call-pattern-properties";
import {
  collectAllOfDeniedPropertyNames,
  collectFalsePropertyNames,
} from "./tool-call-property-deny";
import { selectSchemaVariant } from "./tool-call-schema-variant";

const SELECTIVE_JSON_SCHEMA_COMBINATORS = ["anyOf", "oneOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const falsePropertyNames = collectFalsePropertyNames(schema);
  if (Object.hasOwn(schema, "properties") && isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema !== false) {
        addSafePropertyName(names, key);
      }
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(typeof key === "string" && falsePropertyNames.has(key))) {
        addSafePropertyName(names, key);
      }
    }
  }
  return names;
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function removeNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.delete(name);
  }
}

function collectAllOfDeclaredPropertyNames(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  if (!Array.isArray(schema.allOf)) {
    return null;
  }
  for (const variant of schema.allOf) {
    const nestedNames = collectDeclaredToolInputPropertyNames(
      variant,
      value,
      new Set(seen)
    );
    if (nestedNames) {
      found = true;
      addNames(names, nestedNames);
    }
  }
  return found ? names : null;
}

function collectSelectedVariantDeclaredPropertyNames(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  for (const combinator of SELECTIVE_JSON_SCHEMA_COMBINATORS) {
    const variant = selectSchemaVariant(schema[combinator], value, seen);
    const nestedNames = collectDeclaredToolInputPropertyNames(
      variant,
      value,
      new Set(seen)
    );
    if (nestedNames) {
      found = true;
      addNames(names, nestedNames);
    }
  }
  return found ? names : null;
}

function collectDeclaredToolInputPropertyNames(
  schema: unknown,
  value: unknown,
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
  const strictPatternProperties = hasStrictPatternProperties(unwrapped);
  const allOfNames = collectAllOfDeclaredPropertyNames(unwrapped, value, seen);
  const selectedVariantNames = collectSelectedVariantDeclaredPropertyNames(
    unwrapped,
    value,
    seen
  );
  if (allOfNames) {
    addNames(names, allOfNames);
  }
  if (selectedVariantNames) {
    addNames(names, selectedVariantNames);
  }
  if (
    hasDirectProperties ||
    strictPatternProperties ||
    allOfNames ||
    selectedVariantNames
  ) {
    addNames(names, collectPatternPropertyNames(unwrapped, value));
  }
  removeNames(names, collectAllOfDeniedPropertyNames(unwrapped, new Set(seen)));

  if (
    names.size === 0 &&
    !hasDirectProperties &&
    !strictPatternProperties &&
    !allOfNames &&
    !selectedVariantNames
  ) {
    return null;
  }
  return names;
}

function collectAllOfPropertySchemas(
  schema: Record<string, unknown>,
  key: string,
  value: unknown,
  seen: Set<object>
): unknown[] {
  const propertySchemas: unknown[] = [];
  if (!Array.isArray(schema.allOf)) {
    return propertySchemas;
  }
  for (const variant of schema.allOf) {
    const propertySchema = getDeclaredPropertySchema(
      variant,
      key,
      value,
      new Set(seen)
    );
    if (propertySchema !== undefined) {
      propertySchemas.push(propertySchema);
    }
  }
  return propertySchemas;
}

function collectSelectedVariantPropertySchemas(
  schema: Record<string, unknown>,
  key: string,
  value: unknown,
  seen: Set<object>
): unknown[] {
  const propertySchemas: unknown[] = [];
  for (const combinator of SELECTIVE_JSON_SCHEMA_COMBINATORS) {
    const variant = selectSchemaVariant(schema[combinator], value, seen);
    const propertySchema = getDeclaredPropertySchema(
      variant,
      key,
      value,
      new Set(seen)
    );
    if (propertySchema !== undefined) {
      propertySchemas.push(propertySchema);
    }
  }
  return propertySchemas;
}

function collectPropertySchemaFromCombinators(
  schema: Record<string, unknown>,
  key: string,
  value: unknown,
  seen: Set<object>
): unknown {
  const propertySchemas = [
    ...collectAllOfPropertySchemas(schema, key, value, seen),
    ...collectSelectedVariantPropertySchemas(schema, key, value, seen),
  ];
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
  value: unknown,
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
  const patternSchema = getPatternPropertySchema(unwrapped, key);
  if (patternSchema !== undefined) {
    return patternSchema;
  }
  return collectPropertySchemaFromCombinators(unwrapped, key, value, seen);
}

export function getToolInputPropertyNames(
  schema: unknown,
  value: unknown
): Set<string> | null {
  return collectDeclaredToolInputPropertyNames(schema, value, new Set());
}

export function getToolInputPropertySchema(
  schema: unknown,
  key: string,
  value: unknown
): unknown {
  return getDeclaredPropertySchema(schema, key, value, new Set());
}
