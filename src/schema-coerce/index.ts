import { coerceArrayValue, coerceStringToArray } from "./array-coercion";
import {
  parseLooseStructuredString,
  parseXmlChildrenValue,
} from "./loose-structured-string";
import {
  coercePrimitiveToString,
  coerceStringByEnumWhitespace,
  coerceStringToPrimitive,
  isPrimitiveMatchForSchemaType,
  isPrimitiveSchemaType,
  NUMERIC_REGEX,
} from "./primitive-coercion";
import {
  compileSafePatternPropertyRegex as compileSafePattern,
  getPatternSchemasForKey,
} from "./safe-pattern-regex";
import {
  getSchemaType as getUnwrappedSchemaType,
  schemaIsUnconstrained as isSchemaUnconstrained,
  unwrapJsonSchema as unwrapSchema,
} from "./schema-introspection";
import {
  applyStrictRequiredKeyRename,
  getStrictObjectSchemaInfo,
} from "./strict-object-key-rename";

export function unwrapJsonSchema(schema: unknown): unknown {
  return unwrapSchema(schema);
}

export function getSchemaType(schema: unknown): string | undefined {
  return getUnwrappedSchemaType(schema);
}

export function schemaIsUnconstrained(schema: unknown): boolean {
  return isSchemaUnconstrained(schema);
}

export function compileSafePatternPropertyRegex(
  pattern: string
): RegExp | null {
  return compileSafePattern(pattern);
}

function coerceValueForKey(
  value: unknown,
  key: string,
  unwrapped: Record<string, unknown>
): unknown {
  const schemas: unknown[] = [];
  const props = unwrapped.properties as Record<string, unknown> | undefined;
  if (props && Object.hasOwn(props, key)) {
    schemas.push(props[key]);
  }
  const patternSchemas = getPatternSchemasForKey(
    unwrapped.patternProperties,
    key
  );
  if (patternSchemas.length > 0) {
    schemas.push(...patternSchemas);
  }

  if (schemas.length > 0) {
    let out = value;
    for (const schema of schemas) {
      if (typeof schema === "boolean") {
        continue;
      }
      out = coerceBySchema(out, schema);
    }
    return out;
  }

  const additional = unwrapped.additionalProperties;
  if (
    additional &&
    typeof additional === "object" &&
    !Array.isArray(additional)
  ) {
    return coerceBySchema(value, additional);
  }
  if (additional === true || additional === false) {
    return value;
  }

  return coerceBySchema(value, undefined);
}

function coerceStringWithoutSchema(value: string): unknown {
  const s = value.trim();
  const lower = s.toLowerCase();
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }
  if (NUMERIC_REGEX.test(s)) {
    const num = Number(s);
    if (Number.isFinite(num)) {
      return num;
    }
  }

  if (
    (s.startsWith("{") && s.endsWith("}")) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(s);
      return coerceBySchema(parsed, undefined);
    } catch {
      // Fall through to original string
    }
  }
  return value;
}

function coerceObjectToObject(
  value: Record<string, unknown>,
  unwrapped: Record<string, unknown>
): Record<string, unknown> {
  const normalizedInput = applyStrictRequiredKeyRename(value, unwrapped);
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(normalizedInput)) {
    out[k] = coerceValueForKey(v, k, unwrapped);
  }
  return out;
}

function coerceStringToObject(
  s: string,
  unwrapped: Record<string, unknown>
): unknown {
  const parsed = parseLooseStructuredString(s);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return coerceObjectToObject(parsed as Record<string, unknown>, unwrapped);
  }

  const xmlChildren = parseXmlChildrenValue(s);
  if (xmlChildren) {
    return coerceObjectToObject(xmlChildren, unwrapped);
  }

  return null;
}

function coerceObjectToPrimitive(
  value: Record<string, unknown>,
  schemaType: string | undefined,
  fullSchema?: Record<string, unknown>
): unknown {
  if (!isPrimitiveSchemaType(schemaType)) {
    return null;
  }

  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return null;
  }

  const singleValue = value[keys[0]];
  if (singleValue && typeof singleValue === "object") {
    return null;
  }

  const coerced = coerceBySchema(
    singleValue,
    fullSchema ?? { type: schemaType }
  );
  return isPrimitiveMatchForSchemaType(coerced, schemaType) ? coerced : null;
}

function coerceStringValue(
  value: string,
  schemaType: string | undefined,
  u: Record<string, unknown>
): unknown {
  const s = value.trim();

  if (schemaType === "object") {
    const result = coerceStringToObject(s, u);
    if (result !== null) {
      return result;
    }
  }

  if (schemaType === "array") {
    const result = coerceStringToArray(s, u, coerceBySchema);
    if (result !== null) {
      return result;
    }
  }

  const primitiveResult = coerceStringToPrimitive(s, schemaType);
  if (primitiveResult !== null) {
    return primitiveResult;
  }

  const enumWhitespaceCanonical = coerceStringByEnumWhitespace(s, u);
  if (enumWhitespaceCanonical !== null) {
    return enumWhitespaceCanonical;
  }

  return value;
}

function coerceByStrictAllOfObjectSchemas(
  value: unknown,
  allOf: unknown
): unknown {
  if (!Array.isArray(allOf)) {
    return value;
  }
  let output = value;
  for (const subSchema of allOf) {
    const unwrapped = unwrapJsonSchema(subSchema);
    if (
      unwrapped &&
      typeof unwrapped === "object" &&
      !Array.isArray(unwrapped) &&
      getStrictObjectSchemaInfo(unwrapped as Record<string, unknown>)
    ) {
      output = coerceBySchema(output, subSchema);
    }
  }
  return output;
}

export function coerceBySchema(value: unknown, schema?: unknown): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") {
    if (typeof value === "string") {
      return coerceStringWithoutSchema(value);
    }
    return value;
  }

  const schemaType = getSchemaType(unwrapped);
  const u = unwrapped as Record<string, unknown>;
  const valueAfterAllOf = coerceByStrictAllOfObjectSchemas(value, u.allOf);
  if (
    valueAfterAllOf === null &&
    Array.isArray(u.type) &&
    u.type.includes("null")
  ) {
    return valueAfterAllOf;
  }

  if (typeof valueAfterAllOf === "string") {
    return coerceStringValue(valueAfterAllOf, schemaType, u);
  }

  const primitiveString = coercePrimitiveToString(valueAfterAllOf, schemaType);
  if (primitiveString !== null) {
    return primitiveString;
  }

  if (
    schemaType === "object" &&
    valueAfterAllOf &&
    typeof valueAfterAllOf === "object" &&
    !Array.isArray(valueAfterAllOf)
  ) {
    return coerceObjectToObject(valueAfterAllOf as Record<string, unknown>, u);
  }

  if (
    valueAfterAllOf &&
    typeof valueAfterAllOf === "object" &&
    !Array.isArray(valueAfterAllOf) &&
    isPrimitiveSchemaType(schemaType)
  ) {
    const primitiveResult = coerceObjectToPrimitive(
      valueAfterAllOf as Record<string, unknown>,
      schemaType,
      u
    );
    if (primitiveResult !== null) {
      return primitiveResult;
    }
  }

  if (schemaType === "array") {
    const prefixItems = Array.isArray(u.prefixItems)
      ? (u.prefixItems as unknown[])
      : undefined;
    const itemsSchema = u.items as unknown;

    return coerceArrayValue(
      valueAfterAllOf,
      prefixItems,
      itemsSchema,
      coerceBySchema
    );
  }

  return valueAfterAllOf;
}
