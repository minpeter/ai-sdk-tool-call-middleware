import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaDefinition,
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";
import { getPatternPropertySchema } from "./tool-call-pattern-properties";
import { selectSchemaVariant } from "./tool-call-schema-variant";

const SELECTIVE_JSON_SCHEMA_COMBINATORS = ["anyOf", "oneOf"] as const;

function isToolInputSchema(
  schema: ToolInputSchemaDefinition | undefined
): schema is ToolInputSchema {
  return typeof schema === "object" && isSchemaRecord(schema);
}

function collectAllOfPropertySchemas(
  schema: ToolInputSchema,
  key: string,
  value: RxmlValue,
  seen: Set<object>
): ToolInputSchemaDefinition[] {
  const propertySchemas: ToolInputSchemaDefinition[] = [];
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
  schema: ToolInputSchema,
  key: string,
  value: RxmlValue,
  seen: Set<object>
): ToolInputSchemaDefinition[] {
  const propertySchemas: ToolInputSchemaDefinition[] = [];
  for (const combinator of SELECTIVE_JSON_SCHEMA_COMBINATORS) {
    const variant = selectSchemaVariant(schema[combinator], value, seen);
    if (!isSchemaDefinition(variant)) {
      continue;
    }
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
  schema: ToolInputSchemaDefinition,
  key: string,
  value: RxmlValue,
  seen: Set<object>
): ToolInputSchemaDefinition | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isToolInputSchema(unwrapped) || seen.has(unwrapped)) {
    return;
  }
  seen.add(unwrapped);

  const propertySchemas = [
    ...collectAllOfPropertySchemas(unwrapped, key, value, seen),
    ...collectSelectedVariantPropertySchemas(unwrapped, key, value, seen),
  ];
  if (unwrapped.properties && Object.hasOwn(unwrapped.properties, key)) {
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
    isToolInputSchema(unwrapped.additionalProperties)
  ) {
    return unwrapped.additionalProperties;
  }
  return propertySchemas.length < 2
    ? propertySchemas[0]
    : { allOf: propertySchemas };
}
