import { compileSafePatternPropertyRegex } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasStrictPatternProperties(
  schema: Record<string, unknown>
): boolean {
  return (
    Object.hasOwn(schema, "patternProperties") &&
    isRecord(schema.patternProperties) &&
    schema.additionalProperties === false
  );
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
    if (propertySchema === false) {
      continue;
    }
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
  if (schemas.length === 1) {
    return schemas[0];
  }
  return { allOf: schemas };
}
