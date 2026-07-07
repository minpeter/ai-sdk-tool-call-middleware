import { unwrapJsonSchema } from "../../schema-coerce";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectArrayItemSchemasForVariants(
  variants: unknown,
  index: number,
  seen: Set<object>
): unknown[] {
  const itemSchemas: unknown[] = [];
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
  schema: Record<string, unknown>,
  index: number,
  seen: Set<object>
): unknown[] {
  const itemSchemas: unknown[] = [];
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
  schema: Record<string, unknown>,
  index: number
): unknown[] {
  const schemas: unknown[] = [];
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
