import {
  parseLooseStructuredString,
  parseXmlChildrenValue,
} from "./loose-structured-string";
import {
  compileSafePatternPropertyRegex as compileSafePattern,
  getPatternSchemasForKey,
} from "./safe-pattern-regex";
import {
  getSchemaType as getUnwrappedSchemaType,
  schemaIsUnconstrained as isSchemaUnconstrained,
  schemaHasProperty,
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
// Regex constants for performance
const NUMERIC_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NEWLINE_SPLIT_REGEX = /\n+/;
const COMMA_SPLIT_REGEX = /,\s*/;
const DIGIT_KEY_REGEX = /^\d+$/;
const WHITESPACE_REGEX = /\s+/g;
const HAS_WHITESPACE_REGEX = /\s/;
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';

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

/**
 * Coerce string value without schema information
 */
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

  // Fallback: try parsing JSON-like strings when no schema info
  if (
    (s.startsWith("{") && s.endsWith("}")) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(s);
      return coerceBySchema(parsed, undefined);
    } catch {
      // If parsing fails, return original value
    }
  }
  return value;
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

/**
 * Coerce string to array using schema
 */
function coerceStringToArray(
  s: string,
  unwrapped: Record<string, unknown>
): unknown {
  const prefixItems = Array.isArray(unwrapped.prefixItems)
    ? (unwrapped.prefixItems as unknown[])
    : undefined;
  const itemsSchema = unwrapped.items as unknown;

  const coerceArrayItems = (arr: unknown[]): unknown => {
    if (prefixItems && arr.length === prefixItems.length) {
      return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
    }
    return arr.map((v) => coerceBySchema(v, itemsSchema));
  };

  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return coerceArrayItems(arr);
    }
  } catch {
    // Relaxed parsing (single quotes, unquoted keys, Python literals).
    const parsed = parseLooseStructuredString(s);
    if (Array.isArray(parsed)) {
      return coerceArrayItems(parsed);
    }

    // Fall back to CSV/line splitting for plain enumerations.
    const csv = s.includes("\n")
      ? s.split(NEWLINE_SPLIT_REGEX)
      : s.split(COMMA_SPLIT_REGEX);
    const trimmed = csv.map((x) => x.trim()).filter((x) => x.length > 0);
    if (prefixItems && trimmed.length === prefixItems.length) {
      return trimmed.map((x, i) => coerceBySchema(x, prefixItems[i]));
    }
    return trimmed.map((x) => coerceBySchema(x, itemsSchema));
  }
  return null;
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

/**
 * Coerce array to array using schema
 */
function coerceArrayToArray(
  value: unknown[],
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown
): unknown[] {
  if (prefixItems && value.length === prefixItems.length) {
    return value.map((v, i) => coerceBySchema(v, prefixItems[i]));
  }
  return value.map((v) => coerceBySchema(v, itemsSchema));
}

function isPrimitiveSchemaType(
  schemaType: string | undefined
): schemaType is "string" | "number" | "integer" | "boolean" {
  return (
    schemaType === "string" ||
    schemaType === "number" ||
    schemaType === "integer" ||
    schemaType === "boolean"
  );
}

function isPrimitiveMatchForSchemaType(
  value: unknown,
  schemaType: "string" | "number" | "integer" | "boolean"
): boolean {
  if (schemaType === "string") {
    return typeof value === "string";
  }
  if (schemaType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (schemaType === "integer") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value)
    );
  }
  return typeof value === "boolean";
}

function coercePrimitiveWrappedObject(
  value: Record<string, unknown>,
  itemsSchema: unknown
): unknown {
  const schemaType = getSchemaType(itemsSchema);
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

  const coerced = coerceBySchema(singleValue, itemsSchema);
  return isPrimitiveMatchForSchemaType(coerced, schemaType) ? coerced : null;
}

/**
 * Expand object-of-parallel-arrays into array-of-objects when schema is strict.
 *
 * Example:
 * { field: ["status","amount"], op: ["=",">"], value: ["paid","100"] }
 * -> [
 *   { field: "status", op: "=", value: "paid" },
 *   { field: "amount", op: ">", value: "100" }
 * ]
 *
 * Safety boundary:
 * - items schema must be an object schema with explicit `properties`
 * - `additionalProperties` must be `false`
 * - all input keys must be explicit properties
 * - each mapped property must be primitive-like (not array/object)
 * - all values must be arrays with identical length >= 2
 */
function coerceParallelArraysObjectToArray(
  maybe: Record<string, unknown>,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown
): unknown[] | null {
  if (prefixItems && prefixItems.length > 0) {
    return null;
  }

  const unwrappedItems = unwrapJsonSchema(itemsSchema);
  if (
    !unwrappedItems ||
    typeof unwrappedItems !== "object" ||
    Array.isArray(unwrappedItems)
  ) {
    return null;
  }
  const itemSchema = unwrappedItems as Record<string, unknown>;
  if (getSchemaType(itemSchema) !== "object") {
    return null;
  }
  if (itemSchema.additionalProperties !== false) {
    return null;
  }

  const { properties } = itemSchema;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return null;
  }
  const propertyMap = properties as Record<string, unknown>;

  const entries = Object.entries(maybe);
  if (entries.length < 2) {
    return null;
  }
  if (!entries.every(([, value]) => Array.isArray(value))) {
    return null;
  }
  if (!entries.every(([key]) => Object.hasOwn(propertyMap, key))) {
    return null;
  }
  if (
    !entries.every(([key]) => {
      const schemaType = getSchemaType(propertyMap[key]);
      return schemaType !== "array" && schemaType !== "object";
    })
  ) {
    return null;
  }

  const lengths = [
    ...new Set(entries.map(([, value]) => (value as unknown[]).length)),
  ];
  if (lengths.length !== 1) {
    return null;
  }
  const [length] = lengths;
  if (length < 2) {
    return null;
  }

  const zipped: Record<string, unknown>[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of entries) {
      item[key] = (value as unknown[])[index];
    }
    zipped.push(item);
  }

  return coerceArrayToArray(zipped, prefixItems, itemsSchema);
}

function coerceSingleKeyObjectToArray(
  singleValue: unknown,
  itemsSchema: unknown
): unknown[] | null {
  if (Array.isArray(singleValue)) {
    return singleValue.map((v) => coerceBySchema(v, itemsSchema));
  }
  if (singleValue && typeof singleValue === "object") {
    const primitiveWrapped = coercePrimitiveWrappedObject(
      singleValue as Record<string, unknown>,
      itemsSchema
    );
    if (primitiveWrapped !== null) {
      return [primitiveWrapped];
    }
    return [coerceBySchema(singleValue, itemsSchema)];
  }
  return null;
}

/**
 * Coerce object to array using schema
 */
function coerceObjectToArray(
  maybe: Record<string, unknown>,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown
): unknown {
  if (Object.hasOwn(maybe, "item")) {
    const items = maybe.item as unknown;
    const arr = Array.isArray(items) ? items : [items];
    return coerceArrayToArray(arr, prefixItems, itemsSchema);
  }

  const keys = Object.keys(maybe);

  // Check for numeric keys (traditional tuple handling)
  if (keys.length > 0 && keys.every((k) => DIGIT_KEY_REGEX.test(k))) {
    const arr = keys.sort((a, b) => Number(a) - Number(b)).map((k) => maybe[k]);
    return coerceArrayToArray(arr, prefixItems, itemsSchema);
  }

  const parallelArrays = coerceParallelArraysObjectToArray(
    maybe,
    prefixItems,
    itemsSchema
  );
  if (parallelArrays !== null) {
    return parallelArrays;
  }

  // Check for single field that contains an array or object (common XML pattern)
  // This handles both: { user: [{ name: "A" }, { name: "B" }] } and { user: { name: "A" } }
  if (keys.length === 1) {
    const [singleKey] = keys;
    if (
      !(
        schemaIsUnconstrained(itemsSchema) ||
        schemaHasProperty(itemsSchema, singleKey)
      )
    ) {
      const result = coerceSingleKeyObjectToArray(
        maybe[singleKey],
        itemsSchema
      );
      if (result !== null) {
        return result;
      }
    }
  }

  return null;
}

/**
 * Coerce primitive to array using schema
 */
function coercePrimitiveToArray(
  value: unknown,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown
): unknown[] {
  if (prefixItems && prefixItems.length > 0) {
    return [coerceBySchema(value, prefixItems[0])];
  }
  return [coerceBySchema(value, itemsSchema)];
}

/**
 * Coerce string to primitive type using schema
 */
function coerceStringToPrimitive(
  s: string,
  schemaType: string | undefined
): unknown {
  if (schemaType === "boolean") {
    const lower = s.toLowerCase();
    if (lower === "true") {
      return true;
    }
    if (lower === "false") {
      return false;
    }
  }
  if (
    (schemaType === "number" || schemaType === "integer") &&
    NUMERIC_REGEX.test(s)
  ) {
    const num = Number(s);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function coercePrimitiveToString(
  value: unknown,
  schemaType: string | undefined
): string | null {
  if (schemaType !== "string") {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * Conservative enum canonicalization for whitespace-only differences.
 *
 * Some reasoning-heavy models (for example, ERNIE-4.5-21B-A3B-Thinking) can
 * output spaced enum tokens such as "1 d" while the schema enum is "1d".
 *
 * Safety boundary:
 * - Only runs for string-only enum lists.
 * - Only runs when the model output contains whitespace.
 * - Only rewrites when whitespace-normalized comparison yields exactly one match.
 */
function coerceStringByEnumWhitespace(
  rawValue: string,
  unwrapped: Record<string, unknown>
): string | null {
  const enumValues = unwrapped.enum;
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    return null;
  }
  if (!enumValues.every((item) => typeof item === "string")) {
    return null;
  }
  const normalizedEnumValues = enumValues as string[];
  if (normalizedEnumValues.includes(rawValue)) {
    return null;
  }

  const unquoted = unwrapMatchingQuotes(rawValue);
  if (unquoted !== null) {
    const exactMatches = normalizedEnumValues.filter(
      (item) => item === unquoted
    );
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
  }

  const candidates = [rawValue, unquoted].filter(
    (item): item is string => item !== null
  );
  for (const candidate of candidates) {
    if (!HAS_WHITESPACE_REGEX.test(candidate)) {
      continue;
    }
    const normalizedInput = candidate.replace(WHITESPACE_REGEX, "");
    const matches = normalizedEnumValues.filter(
      (item) => item.replace(WHITESPACE_REGEX, "") === normalizedInput
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return null;
}

function unwrapMatchingQuotes(value: string): string | null {
  if (value.length < 2) {
    return null;
  }
  const first = value.charAt(0);
  const last = value.at(-1);
  const isQuote =
    (first === SINGLE_QUOTE || first === DOUBLE_QUOTE) && first === last;
  if (!isQuote) {
    return null;
  }
  return value.slice(1, -1);
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
    const result = coerceStringToArray(s, u);
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

function coerceArrayValue(
  value: unknown,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown
): unknown {
  if (Array.isArray(value)) {
    return coerceArrayToArray(value, prefixItems, itemsSchema);
  }

  if (value && typeof value === "object") {
    const result = coerceObjectToArray(
      value as Record<string, unknown>,
      prefixItems,
      itemsSchema
    );
    if (result !== null) {
      return result;
    }
    // To prevent infinite recursion, check if the itemsSchema is also for an array.
    // If so, just wrap the object. Otherwise, coerce it against the itemsSchema.
    if (getSchemaType(itemsSchema) === "array") {
      return [value];
    }
    return [coerceBySchema(value, itemsSchema)];
  }

  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return coercePrimitiveToArray(value, prefixItems, itemsSchema);
  }

  return [value];
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

  // Handle string values
  if (typeof valueAfterAllOf === "string") {
    return coerceStringValue(valueAfterAllOf, schemaType, u);
  }

  // Coerce primitive scalars to string when schema explicitly expects a string.
  const primitiveString = coercePrimitiveToString(valueAfterAllOf, schemaType);
  if (primitiveString !== null) {
    return primitiveString;
  }

  // Handle object to object coercion
  if (
    schemaType === "object" &&
    valueAfterAllOf &&
    typeof valueAfterAllOf === "object" &&
    !Array.isArray(valueAfterAllOf)
  ) {
    return coerceObjectToObject(valueAfterAllOf as Record<string, unknown>, u);
  }

  // Handle object wrappers when schema expects a primitive value.
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

  // Handle array coercion
  if (schemaType === "array") {
    const prefixItems = Array.isArray(u.prefixItems)
      ? (u.prefixItems as unknown[])
      : undefined;
    const itemsSchema = u.items as unknown;

    return coerceArrayValue(valueAfterAllOf, prefixItems, itemsSchema);
  }

  return valueAfterAllOf;
}
