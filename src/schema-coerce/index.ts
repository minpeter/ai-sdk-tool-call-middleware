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

function schemaHasPropertyInCombinators(
  s: Record<string, unknown>,
  key: string,
  depth: number
): boolean {
  const anyOfValues = s.anyOf;
  const oneOfValues = s.oneOf;
  const allOfValues = s.allOf;

  let hasCombinator = false;
  let anyOfAllows = true;
  let oneOfAllows = true;
  let allOfAllows = true;

  if (Array.isArray(anyOfValues)) {
    hasCombinator = true;
    anyOfAllows = anyOfValues.some((sub) =>
      schemaHasProperty(sub, key, depth + 1)
    );
  }

  if (Array.isArray(oneOfValues)) {
    hasCombinator = true;
    oneOfAllows = oneOfValues.some((sub) =>
      schemaHasProperty(sub, key, depth + 1)
    );
  }

  if (Array.isArray(allOfValues)) {
    hasCombinator = true;
    allOfAllows = allOfValues.every((sub) =>
      schemaHasProperty(sub, key, depth + 1)
    );
  }

  if (!hasCombinator) {
    return false;
  }

  return anyOfAllows && oneOfAllows && allOfAllows;
}

function schemaHasPropertyDirectly(
  s: Record<string, unknown>,
  key: string
): boolean {
  const props = s.properties;
  if (
    props &&
    typeof props === "object" &&
    !Array.isArray(props) &&
    Object.hasOwn(props, key) &&
    (props as Record<string, unknown>)[key] !== false
  ) {
    return true;
  }
  const required = s.required;
  if (Array.isArray(required) && required.includes(key)) {
    return true;
  }
  const patternSchemas = getPatternSchemasForKey(s.patternProperties, key);
  return patternSchemas.some((schema) => schema !== false);
}

function schemaHasPropertyViaAdditional(s: Record<string, unknown>): boolean {
  const additional = s.additionalProperties;
  if (
    additional === true ||
    (additional && typeof additional === "object" && !Array.isArray(additional))
  ) {
    return true;
  }
  if (Object.hasOwn(s, "additionalProperties")) {
    return false;
  }
  const type = s.type;
  const isObjectType =
    type === "object" || (Array.isArray(type) && type.includes("object"));
  const hasObjectKeywords =
    (s.properties &&
      typeof s.properties === "object" &&
      !Array.isArray(s.properties)) ||
    (s.patternProperties &&
      typeof s.patternProperties === "object" &&
      !Array.isArray(s.patternProperties)) ||
    (Array.isArray(s.required) && s.required.length > 0);
  return !!(isObjectType || hasObjectKeywords);
}

function schemaDisallowsPropertyDirectly(
  s: Record<string, unknown>,
  key: string
): boolean {
  const props = s.properties;
  if (
    props &&
    typeof props === "object" &&
    !Array.isArray(props) &&
    Object.hasOwn(props, key) &&
    (props as Record<string, unknown>)[key] === false
  ) {
    return true;
  }
  const patternSchemas = getPatternSchemasForKey(s.patternProperties, key);
  return patternSchemas.some((schema) => schema === false);
}

function schemaHasProperty(schema: unknown, key: string, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }
  const unwrapped = unwrapJsonSchema(schema);
  // Unconstrained schemas (true, null, {}) allow any property
  if (schemaIsUnconstrained(unwrapped)) {
    return true;
  }
  if (!unwrapped || typeof unwrapped !== "object") {
    return false;
  }
  const s = unwrapped as Record<string, unknown>;

  if (schemaDisallowsPropertyDirectly(s, key)) {
    return false;
  }
  if (schemaHasPropertyDirectly(s, key)) {
    return true;
  }
  if (schemaHasPropertyViaAdditional(s)) {
    return true;
  }
  return schemaHasPropertyInCombinators(s, key, depth);
}

function schemaIsUnconstrained(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped == null || unwrapped === true) {
    return true;
  }
  if (typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return false;
  }
  return Object.keys(unwrapped).length === 0;
}

function getPatternSchemasForKey(
  patternProperties: unknown,
  key: string
): unknown[] {
  if (
    !patternProperties ||
    typeof patternProperties !== "object" ||
    Array.isArray(patternProperties)
  ) {
    return [];
  }
  const schemas: unknown[] = [];
  for (const [pattern, schema] of Object.entries(
    patternProperties as Record<string, unknown>
  )) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(key)) {
        schemas.push(schema);
      }
    } catch {
      // Ignore invalid regex patterns.
    }
  }
  return schemas;
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
      return coerceObjectToObject(obj as Record<string, unknown>, unwrapped);
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
  for (const [k, v] of Object.entries(value)) {
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
    if (
      !(
        schemaIsUnconstrained(itemsSchema) ||
        schemaHasProperty(itemsSchema, singleKey)
      )
    ) {
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
