import type { JSONSchema7 } from "json-schema";

/** JSON Schema dialect accepted by tool-call middleware. */
export type ToolInputSchemaDefinition = boolean | ToolInputSchema;

/** Values accepted at an untrusted schema boundary before narrowing. */
export type ToolInputSchemaCandidate =
  | object
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * Draft-07 schema plus the two schema containers consumed by this package.
 *
 * Recursive fields are redeclared so extensions remain typed at every depth
 * without augmenting the upstream `json-schema` module.
 */
export interface ToolInputSchema extends JSONSchema7 {
  $defs?: Record<string, ToolInputSchemaDefinition>;
  additionalItems?: ToolInputSchemaDefinition;
  additionalProperties?: ToolInputSchemaDefinition;
  allOf?: ToolInputSchemaDefinition[];
  anyOf?: ToolInputSchemaDefinition[];
  contains?: ToolInputSchemaDefinition;
  definitions?: Record<string, ToolInputSchemaDefinition>;
  dependencies?: Record<string, ToolInputSchemaDefinition | string[]>;
  else?: ToolInputSchemaDefinition;
  if?: ToolInputSchemaDefinition;
  items?: ToolInputSchemaDefinition | ToolInputSchemaDefinition[];
  jsonSchema?: ToolInputSchemaDefinition;
  not?: ToolInputSchemaDefinition;
  oneOf?: ToolInputSchemaDefinition[];
  patternProperties?: Record<string, ToolInputSchemaDefinition>;
  prefixItems?: ToolInputSchemaDefinition[];
  properties?: Record<string, ToolInputSchemaDefinition>;
  propertyNames?: ToolInputSchemaDefinition;
  then?: ToolInputSchemaDefinition;
}

export function isSchemaRecord(value: object | null): value is ToolInputSchema {
  if (value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function isSchemaDefinition(
  value: ToolInputSchemaCandidate
): value is ToolInputSchemaDefinition {
  return (
    typeof value === "boolean" ||
    (typeof value === "object" && isSchemaRecord(value))
  );
}

export function readPrefixItems(
  schema: ToolInputSchema
): readonly ToolInputSchemaDefinition[] | undefined {
  return schema.prefixItems;
}
