import { compileSafePatternPropertyRegex } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";
import { unsafeDeniedPatternMayMatchKey } from "./unsafe-pattern";

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasDeclaredPatternProperties<Schema>(schema: Schema): boolean {
  return (
    isRecord(schema) &&
    Object.hasOwn(schema, "patternProperties") &&
    isRecord(schema.patternProperties)
  );
}

export function hasUnsafeFalsePatternProperties<Schema>(
  schema: Schema
): boolean {
  if (!(isRecord(schema) && isRecord(schema.patternProperties))) {
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

export function unsafeFalsePatternMayMatchKey<Schema>(
  schema: Schema,
  key: string
): boolean {
  if (!(isRecord(schema) && isRecord(schema.patternProperties))) {
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
  schema: SchemaBoundaryRecord,
  key: string
): SchemaBoundaryValue[] {
  if (
    isPrototypeSensitiveArgumentKey(key) ||
    !isRecord(schema.patternProperties)
  ) {
    return [];
  }

  const schemas: SchemaBoundaryValue[] = [];
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

export function collectPatternPropertyNames<Schema, Value>(
  schema: Schema,
  value: Value
): Set<string> {
  const names = new Set<string>();
  if (!(isRecord(schema) && isRecord(value))) {
    return names;
  }
  for (const key of Object.keys(value)) {
    if (collectMatchingPatternSchemas(schema, key).length > 0) {
      names.add(key);
    }
  }
  return names;
}

export function getPatternPropertySchema<Schema>(
  schema: Schema,
  key: string
): SchemaBoundaryValue {
  if (!isRecord(schema)) {
    return;
  }
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
