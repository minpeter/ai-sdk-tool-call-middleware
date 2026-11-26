import { unwrapJsonSchema } from "../../../schema-coerce";

const objectSchemaPropertyNamesCache = new WeakMap<
  object,
  Set<string> | null
>();
const schemaAllowsArrayTypeCache = new WeakMap<object, boolean>();
const objectSchemaStringPropertyNamesCache = new WeakMap<
  object,
  Set<string> | null
>();

export function getSchemaObjectProperty(
  schema: unknown,
  propertyName: string
): unknown | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const schemaObject = schema as Record<string, unknown>;
  const { properties } = schemaObject;
  if (!properties || typeof properties !== "object") {
    return null;
  }

  const property = (properties as Record<string, unknown>)[propertyName];
  if (!property) {
    return null;
  }

  return property;
}

function computeObjectSchemaPropertyNames(schema: object): Set<string> | null {
  const schemaObject = schema as {
    type?: unknown;
    properties?: unknown;
  };
  const typeValue = schemaObject.type;
  if (typeValue != null) {
    const isObjectType =
      typeValue === "object" ||
      (Array.isArray(typeValue) && typeValue.includes("object"));
    if (!isObjectType) {
      return null;
    }
  }
  if (!schemaObject.properties || typeof schemaObject.properties !== "object") {
    return new Set<string>();
  }

  return new Set(
    Object.keys(schemaObject.properties as Record<string, unknown>)
  );
}

export function getObjectSchemaPropertyNames(
  schema: unknown
): Set<string> | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const cached = objectSchemaPropertyNamesCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const result = computeObjectSchemaPropertyNames(schema);
  objectSchemaPropertyNamesCache.set(schema, result);
  return result;
}

function computeSchemaAllowsArrayType(schema: unknown): boolean {
  const normalizedSchema = unwrapJsonSchema(schema);
  if (!normalizedSchema || typeof normalizedSchema !== "object") {
    return false;
  }

  const schemaRecord = normalizedSchema as Record<string, unknown>;
  const typeValue = schemaRecord.type;
  if (typeValue === "array") {
    return true;
  }
  if (Array.isArray(typeValue) && typeValue.includes("array")) {
    return true;
  }

  const unions = [schemaRecord.anyOf, schemaRecord.oneOf, schemaRecord.allOf];
  for (const union of unions) {
    if (!Array.isArray(union)) {
      continue;
    }
    if (union.some((entry) => schemaAllowsArrayType(entry))) {
      return true;
    }
  }

  return false;
}

export function schemaAllowsArrayType(schema: unknown): boolean {
  if (schema && typeof schema === "object") {
    const cached = schemaAllowsArrayTypeCache.get(schema);
    if (cached !== undefined) {
      return cached;
    }
    const result = computeSchemaAllowsArrayType(schema);
    schemaAllowsArrayTypeCache.set(schema, result);
    return result;
  }
  return computeSchemaAllowsArrayType(schema);
}

export function schemaAllowsStringType(schema: unknown): boolean {
  const normalizedSchema = unwrapJsonSchema(schema);
  if (!normalizedSchema || typeof normalizedSchema !== "object") {
    return false;
  }

  const schemaRecord = normalizedSchema as Record<string, unknown>;
  const typeValue = schemaRecord.type;
  if (typeValue === "string") {
    return true;
  }
  if (Array.isArray(typeValue) && typeValue.includes("string")) {
    return true;
  }

  const unions = [schemaRecord.anyOf, schemaRecord.oneOf, schemaRecord.allOf];
  for (const union of unions) {
    if (!Array.isArray(union)) {
      continue;
    }
    if (union.some((entry) => schemaAllowsStringType(entry))) {
      return true;
    }
  }

  return false;
}

function computeObjectSchemaStringPropertyNames(
  schema: unknown
): Set<string> | null {
  const propertyNames = getObjectSchemaPropertyNames(schema);
  if (!propertyNames) {
    return null;
  }

  const out = new Set<string>();
  for (const name of propertyNames) {
    const property = getSchemaObjectProperty(schema, name);
    if (schemaAllowsStringType(property)) {
      out.add(name);
    }
  }
  return out;
}

export function getObjectSchemaStringPropertyNames(
  schema: unknown
): Set<string> | null {
  if (schema && typeof schema === "object") {
    const cached = objectSchemaStringPropertyNamesCache.get(schema);
    if (cached !== undefined) {
      return cached;
    }
    const result = computeObjectSchemaStringPropertyNames(schema);
    objectSchemaStringPropertyNamesCache.set(schema, result);
    return result;
  }
  return computeObjectSchemaStringPropertyNames(schema);
}

/**
 * Whether the named schema property is exactly string-typed (no unions or
 * alternative types). Streaming a raw value prefix is only prefix-stable
 * under schema coercion when the property can never be coerced away from a
 * string (e.g. "12" must not become the number 12 once complete).
 */
export function isStrictStringSchemaProperty(
  toolSchema: unknown,
  name: string
): boolean {
  const property = unwrapJsonSchema(getSchemaObjectProperty(toolSchema, name));
  if (!property || typeof property !== "object") {
    return false;
  }
  const typeValue = (property as Record<string, unknown>).type;
  return (
    typeValue === "string" ||
    (Array.isArray(typeValue) &&
      typeValue.length === 1 &&
      typeValue[0] === "string")
  );
}
