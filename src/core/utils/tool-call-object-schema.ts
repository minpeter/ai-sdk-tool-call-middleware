import { unwrapJsonSchema } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import {
  collectPatternPropertyNames,
  getPatternPropertySchema,
  hasDeclaredPatternProperties,
  hasUnsafeFalsePatternProperties,
  unsafeFalsePatternMayMatchKey,
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

function hasStrictAdditionalProperties(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  return isRecord(unwrapped) && unwrapped.additionalProperties === false;
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
      addNames(names, nestedNames);
      found = true;
    }
  }
  return found ? names : null;
}

function collectStrictAllOfDeniedPropertyNames(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): Set<string> {
  const names = new Set<string>();
  if (!(Array.isArray(schema.allOf) && isRecord(value))) {
    return names;
  }
  for (const variant of schema.allOf) {
    const unwrapped = unwrapJsonSchema(variant);
    if (!isRecord(unwrapped) || seen.has(unwrapped)) {
      continue;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(unwrapped);
    if (hasStrictAdditionalProperties(unwrapped)) {
      const allowedNames =
        collectDeclaredToolInputPropertyNames(variant, value, new Set(seen)) ??
        new Set();
      for (const key of Object.keys(value)) {
        if (!allowedNames.has(key)) {
          names.add(key);
        }
      }
    }
    addNames(
      names,
      collectStrictAllOfDeniedPropertyNames(unwrapped, value, nextSeen)
    );
  }
  return names;
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
  const hasAdditionalPropertiesPolicy = Object.hasOwn(
    unwrapped,
    "additionalProperties"
  );
  const declaredPatternProperties = hasDeclaredPatternProperties(unwrapped);
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
    hasAdditionalPropertiesPolicy ||
    declaredPatternProperties ||
    allOfNames ||
    selectedVariantNames
  ) {
    addNames(names, collectPatternPropertyNames(unwrapped, value));
  }
  if (
    ((unwrapped.additionalProperties === true &&
      !hasUnsafeFalsePatternProperties(unwrapped)) ||
      isRecord(unwrapped.additionalProperties)) &&
    isRecord(value)
  ) {
    for (const key of Object.keys(value)) {
      if (!unsafeFalsePatternMayMatchKey(unwrapped, key)) {
        addSafePropertyName(names, key);
      }
    }
  }
  removeNames(names, collectAllOfDeniedPropertyNames(unwrapped, new Set(seen)));
  removeNames(
    names,
    collectStrictAllOfDeniedPropertyNames(unwrapped, value, new Set(seen))
  );

  if (
    names.size === 0 &&
    !hasDirectProperties &&
    !hasAdditionalPropertiesPolicy &&
    !declaredPatternProperties &&
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

  const propertySchemas = [
    ...collectAllOfPropertySchemas(unwrapped, key, value, seen),
    ...collectSelectedVariantPropertySchemas(unwrapped, key, value, seen),
  ];
  if (
    isRecord(unwrapped.properties) &&
    Object.hasOwn(unwrapped.properties, key)
  ) {
    propertySchemas.unshift(unwrapped.properties[key]);
  }
  const patternSchema = getPatternPropertySchema(unwrapped, key);
  if (patternSchema !== undefined) {
    propertySchemas.push(patternSchema);
  }
  if (propertySchemas.some((propertySchema) => propertySchema === false)) {
    return false;
  }
  if (
    propertySchemas.length === 0 &&
    isRecord(unwrapped.additionalProperties)
  ) {
    return unwrapped.additionalProperties;
  }
  return propertySchemas.length < 2
    ? propertySchemas[0]
    : { allOf: propertySchemas };
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
