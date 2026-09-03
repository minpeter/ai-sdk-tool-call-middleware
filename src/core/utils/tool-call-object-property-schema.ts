import { unwrapJsonSchema } from "../../schema-coerce";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";
import { getPatternPropertySchema } from "./tool-call-pattern-properties";
import { selectSchemaVariant } from "./tool-call-schema-variant";

const SELECTIVE_JSON_SCHEMA_COMBINATORS = ["anyOf", "oneOf"] as const;
type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectAllOfPropertySchemas<Value>(
  schema: SchemaBoundaryRecord,
  key: string,
  value: Value,
  seen: Set<object>
): SchemaBoundaryValue[] {
  const propertySchemas: SchemaBoundaryValue[] = [];
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

function collectSelectedVariantPropertySchemas<Value>(
  schema: SchemaBoundaryRecord,
  key: string,
  value: Value,
  seen: Set<object>
): SchemaBoundaryValue[] {
  const propertySchemas: SchemaBoundaryValue[] = [];
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

export function getDeclaredPropertySchema<Schema, Value>(
  schema: Schema,
  key: string,
  value: Value,
  seen: Set<object>
): SchemaBoundaryValue {
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
