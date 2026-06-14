import {
  compileSafePatternPropertyRegex,
  getSchemaType,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { unsafeDeniedPatternMayMatchKey } from "./hermes-unsafe-pattern";

const INTEGER_STRING_RE = /^-?\d+$/;
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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
      if (patternSchema !== true) {
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

function isArraySchema(schema: Record<string, unknown>): boolean {
  return (
    getSchemaType(schema) === "array" ||
    Array.isArray(schema.prefixItems) ||
    Array.isArray(schema.items)
  );
}

function explicitSchemaTypes(schema: Record<string, unknown>): string[] {
  const schemaType = schema.type;
  if (typeof schemaType === "string") {
    return [schemaType];
  }
  if (!Array.isArray(schemaType)) {
    return [];
  }
  return schemaType.filter((type): type is string => typeof type === "string");
}

function valueMatchesSchemaType(value: unknown, schemaType: string): boolean {
  switch (schemaType) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        (typeof value === "number" && Number.isInteger(value)) ||
        (typeof value === "string" &&
          INTEGER_STRING_RE.test(value) &&
          !Number.isFinite(Number(value)))
      );
    case "null":
      return value === null;
    case "number":
      return (
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" &&
          NUMERIC_STRING_RE.test(value) &&
          !Number.isFinite(Number(value)))
      );
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValuesEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key])
    )
  );
}

function valueMatchesSchemaKind(
  value: unknown,
  schema: Record<string, unknown>
): boolean {
  if (Object.hasOwn(schema, "const") && !jsonValuesEqual(value, schema.const)) {
    return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((allowed) => jsonValuesEqual(value, allowed))
  ) {
    return false;
  }
  const schemaTypes = explicitSchemaTypes(schema);
  if (schemaTypes.length > 0) {
    return schemaTypes.some((schemaType) =>
      valueMatchesSchemaType(value, schemaType)
    );
  }
  if (value === null) {
    return true;
  }
  if (isObjectSchema(schema)) {
    return isRecord(value);
  }
  if (isArraySchema(schema)) {
    return Array.isArray(value);
  }
  return true;
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
  seen: Set<object>,
  enforceValueKinds: boolean
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
            new Set(seen),
            enforceValueKinds
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
        new Set(seen),
        enforceValueKinds
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
  seen: Set<object>,
  enforceValueKinds: boolean
): boolean {
  const tupleItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;
  if (tupleItems) {
    return value.every((item, index) => {
      const itemSchema =
        tupleItems[index] ??
        (Array.isArray(schema.items) ? schema.additionalItems : schema.items);
      if (itemSchema === false) {
        return false;
      }
      return argumentValueMatchesSchemaKeyShape(
        item,
        itemSchema,
        seen,
        enforceValueKinds
      );
    });
  }
  return value.every((item) =>
    argumentValueMatchesSchemaKeyShape(
      item,
      schema.items,
      seen,
      enforceValueKinds
    )
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
  const branchMatches = (subSchema: unknown) => {
    const unwrapped = unwrapJsonSchema(subSchema);
    if (isRecord(unwrapped) && !valueMatchesSchemaKind(value, unwrapped)) {
      return false;
    }
    return argumentValueMatchesSchemaKeyShape(
      value,
      subSchema,
      branchSeen(),
      true
    );
  };
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : undefined;
  if (allOf && !allOf.every((subSchema) => branchMatches(subSchema))) {
    return false;
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (anyOf && !anyOf.some((subSchema) => branchMatches(subSchema))) {
    return false;
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (oneOf) {
    const matchCount = oneOf.filter((subSchema) =>
      branchMatches(subSchema)
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
  seen = new Set<object>(),
  enforceValueKinds = false
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return false;
  }
  if (!isRecord(unwrapped)) {
    return true;
  }
  if (enforceValueKinds && !valueMatchesSchemaKind(value, unwrapped)) {
    return false;
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
  if (value === null && explicitSchemaTypes(unwrapped).includes("null")) {
    return true;
  }
  if (isObjectSchema(unwrapped) && !isRecord(value)) {
    return false;
  }
  if (isArraySchema(unwrapped) && !Array.isArray(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    return arrayMatchesSchemaKeyShape(value, unwrapped, seen, enforceValueKinds);
  }
  if (isRecord(value) && isObjectSchema(unwrapped)) {
    return objectMatchesSchemaKeyShape(
      value,
      unwrapped,
      seen,
      enforceValueKinds
    );
  }
  return true;
}
