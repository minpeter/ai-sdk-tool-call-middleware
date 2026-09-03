import { unwrapJsonSchema } from "../../schema-coerce";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";
import {
  collectPatternPropertyNames,
  getPatternPropertySchema,
} from "./tool-call-pattern-properties";
import { collectSchemaSelectionPropertyNames } from "./tool-call-schema-property-names";

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeMatches<Value>(schemaType: string, value: Value): boolean {
  if (schemaType === "object") {
    return isRecord(value);
  }
  if (schemaType === "array") {
    return Array.isArray(value);
  }
  if (schemaType === "string") {
    return typeof value === "string";
  }
  if (schemaType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (schemaType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (schemaType === "boolean") {
    return typeof value === "boolean";
  }
  if (schemaType === "null") {
    return value === null;
  }
  return true;
}

function schemaTypeMatches<Value>(
  schemaType: SchemaBoundaryValue,
  value: Value
): boolean {
  if (typeof schemaType === "string") {
    return jsonTypeMatches(schemaType, value);
  }
  if (!Array.isArray(schemaType)) {
    return true;
  }
  return schemaType.some(
    (entry) => typeof entry === "string" && jsonTypeMatches(entry, value)
  );
}

function requiredPropertiesArePresent<Value>(
  schema: SchemaBoundaryRecord,
  value: Value
): boolean {
  if (!Array.isArray(schema.required)) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return schema.required.every(
    (key) => typeof key !== "string" || Object.hasOwn(value, key)
  );
}

function literalMatches<Value>(
  expected: SchemaBoundaryValue,
  value: Value
): boolean {
  return JSON.stringify(expected) === JSON.stringify(value);
}

function constMatches<Value>(
  schema: SchemaBoundaryRecord,
  value: Value
): boolean {
  if (!Object.hasOwn(schema, "const")) {
    return true;
  }
  return literalMatches(schema.const, value);
}

function enumMatches<Value>(
  schema: SchemaBoundaryRecord,
  value: Value
): boolean {
  if (!Array.isArray(schema.enum)) {
    return true;
  }
  return schema.enum.some((entry) => literalMatches(entry, value));
}

function declaredPropertiesAcceptValues<Value>(
  schema: SchemaBoundaryRecord,
  value: Value,
  seen: Set<object>
): boolean {
  if (!isRecord(value)) {
    return true;
  }
  if (isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (propertySchema === false) {
        return false;
      }
      if (!schemaAcceptsValue(propertySchema, value[key], new Set(seen))) {
        return false;
      }
    }
  }
  for (const key of collectPatternPropertyNames(schema, value)) {
    const propertySchema = getPatternPropertySchema(schema, key);
    if (
      propertySchema !== undefined &&
      !schemaAcceptsValue(propertySchema, value[key], new Set(seen))
    ) {
      return false;
    }
  }
  return true;
}

function schemaAcceptsAllOf<Value>(
  schema: SchemaBoundaryRecord,
  value: Value,
  seen: Set<object>
): boolean {
  if (!Array.isArray(schema.allOf)) {
    return true;
  }
  return schema.allOf.every((variant) =>
    schemaAcceptsValue(variant, value, new Set(seen))
  );
}

function schemaAcceptsAnyOf<Value>(
  schema: SchemaBoundaryRecord,
  value: Value,
  seen: Set<object>
): boolean {
  if (!Array.isArray(schema.anyOf)) {
    return true;
  }
  return schema.anyOf.some((variant) =>
    schemaAcceptsValue(variant, value, new Set(seen))
  );
}

function schemaAcceptsOneOf<Value>(
  schema: SchemaBoundaryRecord,
  value: Value,
  seen: Set<object>
): boolean {
  if (!Array.isArray(schema.oneOf)) {
    return true;
  }
  let matches = 0;
  for (const variant of schema.oneOf) {
    if (schemaAcceptsValue(variant, value, new Set(seen))) {
      matches += 1;
    }
  }
  return matches === 1;
}

function schemaAcceptsValue<Value>(
  schema: SchemaBoundaryValue,
  value: Value,
  seen: Set<object>
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return false;
  }
  if (unwrapped === true || !isRecord(unwrapped)) {
    return true;
  }
  if (seen.has(unwrapped)) {
    return true;
  }
  seen.add(unwrapped);
  return (
    schemaTypeMatches(unwrapped.type, value) &&
    constMatches(unwrapped, value) &&
    enumMatches(unwrapped, value) &&
    requiredPropertiesArePresent(unwrapped, value) &&
    declaredPropertiesAcceptValues(unwrapped, value, seen) &&
    schemaAcceptsAllOf(unwrapped, value, seen) &&
    schemaAcceptsAnyOf(unwrapped, value, seen) &&
    schemaAcceptsOneOf(unwrapped, value, seen)
  );
}

function schemaSelectionScore<Value>(
  schema: SchemaBoundaryValue,
  value: Value
): number {
  if (!isRecord(value)) {
    return 0;
  }
  const names = collectSchemaSelectionPropertyNames(schema);
  const unwrapped = unwrapJsonSchema(schema);
  if (isRecord(unwrapped)) {
    for (const name of collectPatternPropertyNames(unwrapped, value)) {
      names.add(name);
    }
  }
  let score = 0;
  for (const name of names) {
    if (Object.hasOwn(value, name)) {
      score += 2;
    }
  }
  if (isRecord(unwrapped) && unwrapped.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!names.has(key)) {
        score -= 1;
      }
    }
  }
  return score;
}

export function selectSchemaVariant<Schema, Value>(
  variants: Schema,
  value: Value,
  seen: Set<object>
): SchemaBoundaryValue {
  if (!Array.isArray(variants)) {
    return;
  }

  let bestVariant: SchemaBoundaryValue;
  let bestScore = 0;
  for (const variant of variants) {
    if (!schemaAcceptsValue(variant, value, new Set(seen))) {
      continue;
    }
    const score = schemaSelectionScore(variant, value);
    if (bestVariant === undefined || score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }
  if (bestVariant !== undefined) {
    return bestVariant;
  }

  for (const variant of variants) {
    const score = schemaSelectionScore(variant, value);
    if (score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }
  return bestVariant;
}
