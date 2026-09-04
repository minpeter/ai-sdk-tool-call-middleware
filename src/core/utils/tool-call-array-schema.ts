import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";

function isToolInputSchema(
  schema: ToolInputSchemaDefinition | undefined
): schema is ToolInputSchema {
  return typeof schema === "object" && isSchemaRecord(schema);
}

function collectArrayItemSchemasForVariants(
  variants: readonly ToolInputSchemaDefinition[] | undefined,
  index: number,
  seen: Set<object>
): ToolInputSchemaDefinition[] {
  const itemSchemas: ToolInputSchemaDefinition[] = [];
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
  schema: ToolInputSchema,
  index: number,
  seen: Set<object>
): ToolInputSchemaDefinition[] {
  const itemSchemas: ToolInputSchemaDefinition[] = [];
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
  schema: ToolInputSchema,
  index: number
): ToolInputSchemaDefinition[] {
  const schemas: ToolInputSchemaDefinition[] = [];
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
  schema: ToolInputSchemaDefinition,
  index: number,
  seen = new Set<object>()
): ToolInputSchemaDefinition | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isToolInputSchema(unwrapped) || seen.has(unwrapped)) {
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
