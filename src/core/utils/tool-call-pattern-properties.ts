import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { compileSafePatternPropertyRegex } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import { unsafeDeniedPatternMayMatchKey } from "./unsafe-pattern";

function isToolInputSchema(
  schema: ToolInputSchemaDefinition | undefined
): schema is ToolInputSchema {
  return typeof schema === "object" && isSchemaRecord(schema);
}

function isRxmlRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasDeclaredPatternProperties(
  schema: ToolInputSchemaDefinition
): boolean {
  return isToolInputSchema(schema) && schema.patternProperties !== undefined;
}

export function hasUnsafeFalsePatternProperties(
  schema: ToolInputSchemaDefinition
): boolean {
  if (!(isToolInputSchema(schema) && schema.patternProperties)) {
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
  schema: ToolInputSchemaDefinition,
  key: string
): boolean {
  if (!(isToolInputSchema(schema) && schema.patternProperties)) {
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
  if (!(isToolInputSchema(schema) && isRxmlRecord(value))) {
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
  if (!isToolInputSchema(schema)) {
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
