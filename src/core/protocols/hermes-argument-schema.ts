import {
  compileSafePatternPropertyRegex,
  getSchemaType,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { unsafeDeniedPatternMayMatchKey } from "./hermes-unsafe-pattern";

interface PatternSchemaMatches {
  schemas: unknown[];
  unsafeDeniedPatterns: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPatternSchemaMatches(
  patternProperties: unknown,
  key: string
): PatternSchemaMatches {
  if (!isRecord(patternProperties)) {
    return { schemas: [], unsafeDeniedPatterns: [] };
  }
  const schemas: unknown[] = [];
  const unsafeDeniedPatterns: string[] = [];
  for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
    const regex = compileSafePatternPropertyRegex(pattern);
    if (!regex) {
      if (patternSchema === false) {
        unsafeDeniedPatterns.push(pattern);
      }
      continue;
    }
    if (regex.test(key)) {
      schemas.push(patternSchema);
    }
  }
  return { schemas, unsafeDeniedPatterns };
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    getSchemaType(schema) === "object" ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    Array.isArray(schema.required) ||
    Object.hasOwn(schema, "additionalProperties")
  );
}

function getPropertySchema(
  schema: Record<string, unknown>,
  key: string
): unknown | undefined {
  const properties = schema.properties;
  if (!isRecord(properties) || !Object.hasOwn(properties, key)) {
    return;
  }
  return properties[key];
}

function requiredKeys(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter(
        (key): key is string => typeof key === "string" && key.length > 0
      )
    : [];
}

function objectMatchesSchemaKeyShape(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  seen: Set<object>
): boolean {
  if (requiredKeys(schema).some((key) => !Object.hasOwn(value, key))) {
    return false;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const propertySchema = getPropertySchema(schema, key);
    if (propertySchema === false) {
      return false;
    }

    const patternMatches = getPatternSchemaMatches(
      schema.patternProperties,
      key
    );
    const patternSchemas = patternMatches.schemas;
    if (patternSchemas.some((patternSchema) => patternSchema === false)) {
      return false;
    }
    if (
      patternMatches.unsafeDeniedPatterns.some((pattern) =>
        unsafeDeniedPatternMayMatchKey(pattern, key)
      )
    ) {
      return false;
    }

    const schemasToValidate = [
      ...(propertySchema === undefined ? [] : [propertySchema]),
      ...patternSchemas.filter((patternSchema) => patternSchema !== false),
    ];
    if (schemasToValidate.length > 0) {
      if (
        !schemasToValidate.every((nestedSchema) =>
          argumentValueMatchesSchemaKeyShape(
            nestedValue,
            nestedSchema,
            new Set(seen)
          )
        )
      ) {
        return false;
      }
      continue;
    }

    const additionalSchema = schema.additionalProperties;
    if (additionalSchema === false) {
      return false;
    }
    if (
      isRecord(additionalSchema) &&
      !argumentValueMatchesSchemaKeyShape(
        nestedValue,
        additionalSchema,
        new Set(seen)
      )
    ) {
      return false;
    }
  }

  return true;
}

function arrayMatchesSchemaKeyShape(
  value: unknown[],
  schema: Record<string, unknown>,
  seen: Set<object>
): boolean {
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : undefined;
  if (prefixItems) {
    return value.every((item, index) => {
      const itemSchema = prefixItems[index] ?? schema.items;
      return argumentValueMatchesSchemaKeyShape(item, itemSchema, seen);
    });
  }
  return value.every((item) =>
    argumentValueMatchesSchemaKeyShape(item, schema.items, seen)
  );
}

function schemaCombinatorsMatch(
  value: unknown,
  schema: Record<string, unknown>,
  seen: Set<object>
): boolean {
  const branchSeen = () => {
    const nextSeen = new Set(seen);
    if (isRecord(value) || Array.isArray(value)) {
      nextSeen.delete(value);
    }
    return nextSeen;
  };
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : undefined;
  if (
    allOf &&
    !allOf.every((subSchema) =>
      argumentValueMatchesSchemaKeyShape(value, subSchema, branchSeen())
    )
  ) {
    return false;
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (
    anyOf &&
    !anyOf.some((subSchema) =>
      argumentValueMatchesSchemaKeyShape(value, subSchema, branchSeen())
    )
  ) {
    return false;
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (oneOf) {
    const matchCount = oneOf.filter((subSchema) =>
      argumentValueMatchesSchemaKeyShape(value, subSchema, branchSeen())
    ).length;
    if (matchCount !== 1) {
      return false;
    }
  }

  return true;
}

export function argumentValueMatchesSchemaKeyShape(
  value: unknown,
  schema: unknown,
  seen = new Set<object>()
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return false;
  }
  if (!isRecord(unwrapped)) {
    return true;
  }
  if (isRecord(value) || Array.isArray(value)) {
    if (seen.has(value)) {
      return true;
    }
    seen.add(value);
  }
  if (!schemaCombinatorsMatch(value, unwrapped, seen)) {
    return false;
  }
  if (Array.isArray(value)) {
    return arrayMatchesSchemaKeyShape(value, unwrapped, seen);
  }
  if (isRecord(value) && isObjectSchema(unwrapped)) {
    return objectMatchesSchemaKeyShape(value, unwrapped, seen);
  }
  return true;
}
