import { unwrapJsonSchema } from "../../schema-coerce";

const JSON_SCHEMA_COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectArrayItemSchemasFromCombinators(
  schema: Record<string, unknown>,
  index: number,
  seen: Set<object>
): unknown[] {
  const itemSchemas: unknown[] = [];
  for (const combinator of JSON_SCHEMA_COMBINATORS) {
    const variants = schema[combinator];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const variantSchema = getArrayItemSchema(variant, index, new Set(seen));
      if (variantSchema !== undefined) {
        itemSchemas.push(variantSchema);
      }
    }
  }
  return itemSchemas;
}

export function getArrayItemSchema(
  schema: unknown,
  index: number,
  seen = new Set<object>()
): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return;
  }
  seen.add(unwrapped);

  const schemas: unknown[] = [];
  if (
    Array.isArray(unwrapped.prefixItems) &&
    index < unwrapped.prefixItems.length
  ) {
    schemas.push(unwrapped.prefixItems[index]);
  }
  if (unwrapped.items !== undefined) {
    schemas.push(unwrapped.items);
  }
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
