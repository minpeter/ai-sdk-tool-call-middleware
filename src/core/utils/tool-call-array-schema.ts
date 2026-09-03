import { unwrapJsonSchema } from "../../schema-coerce";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectArrayItemSchemasForVariants(
  variants: SchemaBoundaryValue,
  index: number,
  seen: Set<object>
): SchemaBoundaryValue[] {
  const itemSchemas: SchemaBoundaryValue[] = [];
  if (!Array.isArray(variants)) {
    return itemSchemas;
  }
  for (const variant of variants) {
    const variantSchema = getArrayItemSchema(variant, index, new Set(seen));
    if (variantSchema !== undefined) {
      itemSchemas.push(variantSchema);
    }
  }
  return itemSchemas;
}

function collectArrayItemSchemasFromCombinators(
  schema: SchemaBoundaryRecord,
  index: number,
  seen: Set<object>
): SchemaBoundaryValue[] {
  const itemSchemas: SchemaBoundaryValue[] = [];
  itemSchemas.push(
    ...collectArrayItemSchemasForVariants(schema.allOf, index, seen)
  );

  const anyOfItemSchemas = collectArrayItemSchemasForVariants(
    schema.anyOf,
    index,
    seen
  );
  if (anyOfItemSchemas.length > 0) {
    itemSchemas.push({ anyOf: anyOfItemSchemas });
  }

  const oneOfItemSchemas = collectArrayItemSchemasForVariants(
    schema.oneOf,
    index,
    seen
  );
  if (oneOfItemSchemas.length > 0) {
    itemSchemas.push({ oneOf: oneOfItemSchemas });
  }
  return itemSchemas;
}

function collectDirectArrayItemSchemas(
  schema: SchemaBoundaryRecord,
  index: number
): SchemaBoundaryValue[] {
  const schemas: SchemaBoundaryValue[] = [];
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : null;
  const hasPrefixItem = prefixItems !== null && index < prefixItems.length;
  if (hasPrefixItem) {
    schemas.push(prefixItems[index]);
    return schemas;
  }

  if (Array.isArray(schema.items)) {
    if (index < schema.items.length) {
      schemas.push(schema.items[index]);
    } else if (schema.additionalItems !== undefined) {
      schemas.push(schema.additionalItems);
    }
    return schemas;
  }

  if (schema.items !== undefined) {
    schemas.push(schema.items);
  }
  return schemas;
}

export function getArrayItemSchema<Schema>(
  schema: Schema,
  index: number,
  seen = new Set<object>()
): SchemaBoundaryValue {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return;
  }
  seen.add(unwrapped);

  const schemas = collectDirectArrayItemSchemas(unwrapped, index);
  schemas.push(
    ...collectArrayItemSchemasFromCombinators(unwrapped, index, seen)
  );

  if (schemas.length === 0) {
    return;
  }
  if (schemas.length === 1) {
    return schemas[0];
  }
  return { allOf: schemas };
}
