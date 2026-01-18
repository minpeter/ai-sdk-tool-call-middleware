// Regex constants for performance
const NUMERIC_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const EMPTY_OBJECT_REGEX = /^\{\s*\}$/s;
const NEWLINE_SPLIT_REGEX = /\n+/;
const COMMA_SPLIT_REGEX = /,\s*/;
const DIGIT_KEY_REGEX = /^\d+$/;

export function unwrapJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const s = schema as Record<string, unknown>;
  if (s.jsonSchema && typeof s.jsonSchema === "object") {
    return unwrapJsonSchema(s.jsonSchema);
  }
  return schema;
}

export function getSchemaType(schema: unknown): string | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") {
    return;
  }
  const t: unknown = (unwrapped as Record<string, unknown>).type;
  if (typeof t === "string") {
    return t;
  }
  if (Array.isArray(t)) {
    const preferred = [
      "object",
      "array",
      "boolean",
      "number",
      "integer",
      "string",
    ];
    for (const p of preferred) {
      if (t.includes(p)) {
        return p;
      }
    }
  }
  const s = unwrapped as Record<string, unknown>;
  if (s && typeof s === "object" && (s.properties || s.additionalProperties)) {
    return "object";
  }
  if (
    s &&
    typeof s === "object" &&
    (s.items || (s as Record<string, unknown>).prefixItems)
  ) {
    return "array";
  }
  return;
}

function schemaHasProperty(schema: unknown, key: string, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") {
    return false;
  }
  const s = unwrapped as Record<string, unknown>;
  const props = s.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    if (Object.hasOwn(props as Record<string, unknown>, key)) {
      return true;
    }
  }
  const required = s.required;
  if (Array.isArray(required) && required.includes(key)) {
    return true;
  }
  const combinators = ["anyOf", "oneOf", "allOf"] as const;
  for (const comb of combinators) {
    const values = s[comb];
    if (Array.isArray(values)) {
      for (const sub of values) {
        if (schemaHasProperty(sub, key, depth + 1)) {
          return true;
        }
      }
    }
  }
  return false;
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

/**
 * Coerce string to object using schema
 */
function coerceStringToObject(
  s: string,
  unwrapped: Record<string, unknown>
): unknown {
  try {
    let normalized = s.replace(/'/g, '"');
    normalized = normalized.replace(EMPTY_OBJECT_REGEX, "{}");

    const obj = JSON.parse(normalized);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const props = unwrapped.properties as Record<string, unknown> | undefined;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const propSchema = props ? (props[k] as unknown) : undefined;
        out[k] =
          typeof propSchema === "boolean" ? v : coerceBySchema(v, propSchema);
      }
      return out;
    }
  } catch {
    // fallthrough
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

  try {
    const normalized = s.replace(/'/g, '"');
    const arr = JSON.parse(normalized);
    if (Array.isArray(arr)) {
      if (prefixItems && arr.length === prefixItems.length) {
        return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
      }
      return arr.map((v) => coerceBySchema(v, itemsSchema));
    }
  } catch {
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

/**
 * Coerce object to object using schema
 */
function coerceObjectToObject(
  value: Record<string, unknown>,
  unwrapped: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = unwrapped.properties as Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(value)) {
    const propSchema = props ? (props[k] as unknown) : undefined;
    out[k] =
      typeof propSchema === "boolean" ? v : coerceBySchema(v, propSchema);
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

  // Check for single field that contains an array or object (common XML pattern)
  // This handles both: { user: [{ name: "A" }, { name: "B" }] } and { user: { name: "A" } }
  if (keys.length === 1) {
    const singleKey = keys[0];
    if (!schemaHasProperty(itemsSchema, singleKey)) {
      const singleValue = maybe[singleKey];
      if (Array.isArray(singleValue)) {
        return singleValue.map((v) => coerceBySchema(v, itemsSchema));
      }
      // Also extract when single key's value is an object and wrap in array (single/multiple element consistency)
      if (singleValue && typeof singleValue === "object") {
        return [coerceBySchema(singleValue, itemsSchema)];
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
    // Wrap in array even if object couldn't be converted to array
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

  // Handle string values
  if (typeof value === "string") {
    return coerceStringValue(value, schemaType, u);
  }

  // Handle object to object coercion
  if (
    schemaType === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return coerceObjectToObject(value as Record<string, unknown>, u);
  }

  // Handle array coercion
  if (schemaType === "array") {
    const prefixItems = Array.isArray(u.prefixItems)
      ? (u.prefixItems as unknown[])
      : undefined;
    const itemsSchema = u.items as unknown;

    return coerceArrayValue(value, prefixItems, itemsSchema);
  }

  return value;
}
