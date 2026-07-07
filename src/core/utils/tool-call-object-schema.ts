import {
  compileSafePatternPropertyRegex,
  unwrapJsonSchema,
} from "../../schema-coerce";
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

function intersectNames(target: Set<string>, source: Set<string>): void {
  for (const name of target) {
    if (!source.has(name)) {
      target.delete(name);
    }
  }
}

function hasStrictAdditionalProperties(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  return isRecord(unwrapped) && unwrapped.additionalProperties === false;
}

function hasUnsafeFalsePatternProperties(
  schema: Record<string, unknown>
): boolean {
  if (!isRecord(schema.patternProperties)) {
    return false;
  }
  for (const [pattern, propertySchema] of Object.entries(
    schema.patternProperties
  )) {
    if (
      propertySchema === false &&
      compileSafePatternPropertyRegex(pattern) === null
    ) {
      return true;
    }
  }
  return false;
}

function collectAllOfDeclaredPropertyNames(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  let hasStrictVariant = false;
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
      const currentStrictVariant = hasStrictAdditionalProperties(variant);
      if (found && (hasStrictVariant || currentStrictVariant)) {
        intersectNames(names, nestedNames);
      } else {
        addNames(names, nestedNames);
      }
      found = true;
      hasStrictVariant ||= currentStrictVariant;
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
  const hasAdditionalPropertiesPolicy = Object.hasOwn(
    unwrapped,
    "additionalProperties"
  );
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
    hasAdditionalPropertiesPolicy ||
    strictPatternProperties ||
    allOfNames ||
    selectedVariantNames
  ) {
    addNames(names, collectPatternPropertyNames(unwrapped, value));
  }
  if (
    (unwrapped.additionalProperties === true ||
      isRecord(unwrapped.additionalProperties)) &&
    !hasUnsafeFalsePatternProperties(unwrapped) &&
    isRecord(value)
  ) {
    for (const key of Object.keys(value)) {
      addSafePropertyName(names, key);
    }
  }
  removeNames(names, collectAllOfDeniedPropertyNames(unwrapped, new Set(seen)));

  if (
    names.size === 0 &&
    !hasDirectProperties &&
    !hasAdditionalPropertiesPolicy &&
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
