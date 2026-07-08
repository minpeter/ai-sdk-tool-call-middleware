import { compileSafePatternPropertyRegex } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import { unsafeDeniedPatternMayMatchKey } from "./unsafe-pattern";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasDeclaredPatternProperties(
  schema: Record<string, unknown>
): boolean {
  return (
    Object.hasOwn(schema, "patternProperties") &&
    isRecord(schema.patternProperties)
  );
}

export function hasUnsafeFalsePatternProperties(
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

export function unsafeFalsePatternMayMatchKey(
  schema: Record<string, unknown>,
  key: string
): boolean {
  if (!isRecord(schema.patternProperties)) {
    return false;
  }
  for (const [pattern, propertySchema] of Object.entries(
    schema.patternProperties
  )) {
    if (
      propertySchema === false &&
      compileSafePatternPropertyRegex(pattern) === null &&
      unsafeDeniedPatternMayMatchKey(pattern, key)
    ) {
      return true;
    }
  }
  return false;
}

function collectMatchingPatternSchemas(
  schema: Record<string, unknown>,
  key: string
): unknown[] {
  if (
    isPrototypeSensitiveArgumentKey(key) ||
    !isRecord(schema.patternProperties)
  ) {
    return [];
  }

  const schemas: unknown[] = [];
  for (const [pattern, propertySchema] of Object.entries(
    schema.patternProperties
  )) {
    const regex = compileSafePatternPropertyRegex(pattern);
    if (regex?.test(key)) {
      schemas.push(propertySchema);
    }
  }
  return schemas;
}

export function collectPatternPropertyNames(
  schema: Record<string, unknown>,
  value: unknown
): Set<string> {
  const names = new Set<string>();
  if (!isRecord(value)) {
    return names;
  }
  for (const key of Object.keys(value)) {
    if (collectMatchingPatternSchemas(schema, key).length > 0) {
      names.add(key);
    }
  }
  return names;
}

export function getPatternPropertySchema(
  schema: Record<string, unknown>,
  key: string
): unknown {
  const schemas = collectMatchingPatternSchemas(schema, key);
  if (schemas.length === 0) {
    return;
  }
  if (schemas.some((patternSchema) => patternSchema === false)) {
    return false;
  }
  if (schemas.length === 1) {
    return schemas[0];
  }
  return { allOf: schemas };
}
