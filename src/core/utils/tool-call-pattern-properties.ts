import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { compileSafePatternPropertyRegex } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import { unsafeDeniedPatternMayMatchKey } from "./unsafe-pattern";

export function isRxmlRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasDeclaredPatternProperties(
  schema: ToolInputSchemaDefinition
): boolean {
  return isSchemaRecord(schema) && schema.patternProperties !== undefined;
}

function collectUnsafeFalsePatterns(
  schema: ToolInputSchemaDefinition
): string[] {
  if (!(isSchemaRecord(schema) && schema.patternProperties)) {
    return [];
  }
  const patterns: string[] = [];
  for (const [pattern, propertySchema] of Object.entries(
    schema.patternProperties
  )) {
    if (
      propertySchema === false &&
      compileSafePatternPropertyRegex(pattern) === null
    ) {
      patterns.push(pattern);
    }
  }
  return patterns;
}

export function hasUnsafeFalsePatternProperties(
  schema: ToolInputSchemaDefinition
): boolean {
  return collectUnsafeFalsePatterns(schema).length > 0;
}

export function unsafeFalsePatternMayMatchKey(
  schema: ToolInputSchemaDefinition,
  key: string
): boolean {
  return collectUnsafeFalsePatterns(schema).some((pattern) =>
    unsafeDeniedPatternMayMatchKey(pattern, key)
  );
}

function collectMatchingPatternSchemas(
  schema: ToolInputSchema,
  key: string
): ToolInputSchemaDefinition[] {
  if (isPrototypeSensitiveArgumentKey(key) || !schema.patternProperties) {
    return [];
  }

  const schemas: ToolInputSchemaDefinition[] = [];
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
  schema: ToolInputSchemaDefinition,
  value: RxmlValue
): Set<string> {
  const names = new Set<string>();
  if (!(isSchemaRecord(schema) && isRxmlRecord(value))) {
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
  schema: ToolInputSchemaDefinition,
  key: string
): ToolInputSchemaDefinition | undefined {
  if (!isSchemaRecord(schema)) {
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
