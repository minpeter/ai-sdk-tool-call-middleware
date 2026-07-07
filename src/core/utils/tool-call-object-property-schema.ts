import { unwrapJsonSchema } from "../../schema-coerce";
import { getPatternPropertySchema } from "./tool-call-pattern-properties";
import { selectSchemaVariant } from "./tool-call-schema-variant";

const SELECTIVE_JSON_SCHEMA_COMBINATORS = ["anyOf", "oneOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function getDeclaredPropertySchema(
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
