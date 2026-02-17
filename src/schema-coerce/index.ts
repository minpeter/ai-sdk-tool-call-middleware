// Regex constants for performance
const NUMERIC_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const EMPTY_OBJECT_REGEX = /^\{\s*\}$/s;
const NEWLINE_SPLIT_REGEX = /\n+/;
const COMMA_SPLIT_REGEX = /,\s*/;
const DIGIT_KEY_REGEX = /^\d+$/;
const WHITESPACE_REGEX = /\s+/g;
const HAS_WHITESPACE_REGEX = /\s/;
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const SNAKE_SEGMENT_REGEX = /_([a-zA-Z0-9])/g;
const CAMEL_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g;
const LEADING_UNDERSCORES_REGEX = /^_+/;

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

/**
 * Checks if a property is allowed through schema combinators (anyOf, oneOf, allOf).
 *
 * @param s - The schema object to check
 * @param key - The property key to look for
 * @param depth - Current recursion depth
 * @returns `true` if at least one combinator exists AND allows the property;
 *          `false` if no combinators exist OR none allow the property.
 *          When no combinators are present, returns `false` so the caller can
 *          fall back to other property-checking methods.
 *
 * **oneOf semantics**: JSON Schema's `oneOf` requires exactly one schema to match,
 * but for coercion heuristics we treat it like `anyOf` (at least one allows).
 * This is intentional because:
 * 1. We're determining if a property CAN exist, not validating exact matches
 * 2. Coercion should be permissive - if any branch allows the property, we allow it
 * 3. Strict oneOf validation would require runtime value inspection, not just schema analysis
 */
function schemaAllowsPropertyViaCombinators(
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

/**
 * Checks if a schema allows additional properties beyond those explicitly defined.
 *
 * JSON Schema behavior for additionalProperties:
 * - `additionalProperties: true` or `additionalProperties: { schema }`: Explicitly allows additional properties
 * - `additionalProperties: false`: Explicitly disallows additional properties
 * - `additionalProperties` not specified: Defaults to allowing additional properties (JSON Schema spec)
 *
 * When `additionalProperties` is not explicitly set, this function returns `true` if the schema
 * appears to be an object schema (has `type: "object"`, `properties`, `patternProperties`, or `required`).
 * This follows the JSON Schema specification where omitting `additionalProperties` is equivalent to `true`.
 *
 * **Important**: This means schemas like `{ type: "object", properties: { foo: ... } }` without
 * `additionalProperties: false` will be treated as allowing any additional property, which affects
 * single-key object unwrapping behavior in array coercion.
 *
 * @param s - The schema object to check
 * @returns `true` if the schema allows additional properties, `false` otherwise
 */
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

/**
 * Checks if a schema allows a specific property key.
 *
 * Recursively checks through schema combinators (allOf, anyOf, oneOf) to determine
 * if the given key is allowed by the schema.
 *
 * @param schema - The JSON Schema to check
 * @param key - The property key to check for
 * @param depth - Current recursion depth (default: 0)
 * @returns `true` if the schema allows the property, `false` otherwise
 *
 * @remarks
 * The depth limit of 5 prevents infinite recursion in deeply nested or circular
 * schema references. This limit is sufficient for most real-world schemas while
 * protecting against pathological cases. When the limit is exceeded, the function
 * conservatively returns `true` to prevent unwrapping - it's safer to keep a
 * wrapper key than to incorrectly remove it and lose data.
 */
function schemaHasProperty(schema: unknown, key: string, depth = 0): boolean {
  if (depth > 5) {
    return true;
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
  return schemaAllowsPropertyViaCombinators(s, key, depth);
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

/**
 * Gets all schemas from patternProperties that match the given key.
 *
 * @param patternProperties - The patternProperties object from a JSON Schema
 * @param key - The property key to match against patterns
 * @returns Array of schemas whose patterns match the key
 *
 * @remarks
 * **Security consideration**: This function executes regex patterns from the schema.
 * In typical usage (AI SDK tool parsing), schemas come from trusted application code.
 * However, if schemas can originate from untrusted sources, be aware of potential
 * ReDoS (Regular Expression Denial of Service) with malicious patterns like `(a+)+$`.
 * Consider adding regex timeout or safe-regex validation if processing untrusted schemas.
 */
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
  // First try parsing the original string as-is
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return coerceObjectToObject(obj as Record<string, unknown>, unwrapped);
    }
  } catch {
    // Fallback: try replacing single quotes with double quotes
    // (for cases where model uses single-quoted JSON)
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
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      if (prefixItems && arr.length === prefixItems.length) {
        return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
      }
      return arr.map((v) => coerceBySchema(v, itemsSchema));
    }
  } catch {
    // Fallback: try replacing single quotes with double quotes
    // (for cases where model uses single-quoted JSON)
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
      // Both failed — fall through to CSV split
    }
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

interface StrictObjectSchemaInfo {
  patternProperties?: Record<string, unknown>;
  properties: Record<string, unknown>;
  required: string[];
}

function getStrictObjectSchemaInfo(
  unwrapped: Record<string, unknown>
): StrictObjectSchemaInfo | null {
  if (getSchemaType(unwrapped) !== "object") {
    return null;
  }
  if (unwrapped.additionalProperties !== false) {
    return null;
  }

  const properties = unwrapped.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return null;
  }

  const propertyMap = properties as Record<string, unknown>;
  const required = Array.isArray(unwrapped.required)
    ? unwrapped.required.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      )
    : [];

  const patternProps = unwrapped.patternProperties;
  const patternProperties =
    patternProps &&
    typeof patternProps === "object" &&
    !Array.isArray(patternProps)
      ? (patternProps as Record<string, unknown>)
      : undefined;

  return {
    properties: propertyMap,
    required,
    patternProperties,
  };
}

function isSingularPluralPair(left: string, right: string): boolean {
  return (
    left.length > 1 &&
    right.length > 1 &&
    (left === `${right}s` || right === `${left}s`)
  );
}

function snakeToCamel(value: string): string {
  const trimmed = value.replace(LEADING_UNDERSCORES_REGEX, "");
  if (trimmed.length === 0) {
    return value;
  }
  const camelized = trimmed.replace(SNAKE_SEGMENT_REGEX, (_, c: string) =>
    c.toUpperCase()
  );
  return camelized.charAt(0).toLowerCase() + camelized.slice(1);
}

function camelToSnake(value: string): string {
  return value.replace(CAMEL_BOUNDARY_REGEX, "$1_$2").toLowerCase();
}

function isCaseStylePair(targetKey: string, sourceKey: string): boolean {
  if (targetKey === sourceKey) {
    return false;
  }
  const sourceLooksSnake = sourceKey.includes("_");
  const targetLooksSnake = targetKey.includes("_");

  if (sourceLooksSnake && snakeToCamel(sourceKey) === targetKey) {
    return true;
  }
  if (
    !sourceLooksSnake &&
    targetLooksSnake &&
    camelToSnake(sourceKey) === targetKey
  ) {
    return true;
  }
  return false;
}

function isUnexpectedKey(
  key: string,
  schemaInfo: StrictObjectSchemaInfo
): boolean {
  if (Object.hasOwn(schemaInfo.properties, key)) {
    return false;
  }
  const patternSchemas = getPatternSchemasForKey(
    schemaInfo.patternProperties,
    key
  );
  if (patternSchemas.length > 0) {
    return patternSchemas.every((schema) => schema === false);
  }
  return true;
}

function computeMissingAndUnexpectedKeys(
  input: Record<string, unknown>,
  schemaInfo: StrictObjectSchemaInfo
): { missingRequired: string[]; unexpectedKeys: string[] } {
  const missingRequired = schemaInfo.required.filter(
    (key) => !Object.hasOwn(input, key)
  );
  const unexpectedKeys = Object.keys(input).filter((key) =>
    isUnexpectedKey(key, schemaInfo)
  );
  return { missingRequired, unexpectedKeys };
}

function applySingularPluralRequiredKeyRename(
  input: Record<string, unknown>,
  schemaInfo: StrictObjectSchemaInfo
): Record<string, unknown> | null {
  const { missingRequired, unexpectedKeys } = computeMissingAndUnexpectedKeys(
    input,
    schemaInfo
  );

  if (missingRequired.length !== 1 || unexpectedKeys.length !== 1) {
    return null;
  }

  const targetKey = missingRequired[0];
  const sourceKey = unexpectedKeys[0];
  if (!Object.hasOwn(schemaInfo.properties, targetKey)) {
    return null;
  }
  if (!isSingularPluralPair(targetKey, sourceKey)) {
    return null;
  }
  if (getSchemaType(schemaInfo.properties[targetKey]) !== "array") {
    return null;
  }
  if (!Array.isArray(input[sourceKey])) {
    return null;
  }
  if (!Object.hasOwn(input, sourceKey) || Object.hasOwn(input, targetKey)) {
    return null;
  }

  const output: Record<string, unknown> = { ...input };
  output[targetKey] = output[sourceKey];
  delete output[sourceKey];
  return output;
}

function applyCaseStyleRequiredKeyRename(
  input: Record<string, unknown>,
  schemaInfo: StrictObjectSchemaInfo
): Record<string, unknown> | null {
  const { missingRequired, unexpectedKeys } = computeMissingAndUnexpectedKeys(
    input,
    schemaInfo
  );

  if (missingRequired.length !== 1 || unexpectedKeys.length !== 1) {
    return null;
  }

  const targetKey = missingRequired[0];
  const sourceKey = unexpectedKeys[0];
  if (!Object.hasOwn(schemaInfo.properties, targetKey)) {
    return null;
  }
  if (!isCaseStylePair(targetKey, sourceKey)) {
    return null;
  }
  if (!Object.hasOwn(input, sourceKey) || Object.hasOwn(input, targetKey)) {
    return null;
  }

  const output: Record<string, unknown> = { ...input };
  output[targetKey] = output[sourceKey];
  delete output[sourceKey];
  return output;
}

function applyStrictRequiredKeyRename(
  input: Record<string, unknown>,
  unwrapped: Record<string, unknown>
): Record<string, unknown> {
  const schemaInfo = getStrictObjectSchemaInfo(unwrapped);
  if (!schemaInfo) {
    return input;
  }

  const singularPlural = applySingularPluralRequiredKeyRename(
    input,
    schemaInfo
  );
  if (singularPlural) {
    return singularPlural;
  }

  const caseStyle = applyCaseStyleRequiredKeyRename(input, schemaInfo);
  if (caseStyle) {
    return caseStyle;
  }

  return input;
}

/**
 * Coerce object to object using schema
 */
function coerceObjectToObject(
  value: Record<string, unknown>,
  unwrapped: Record<string, unknown>
): Record<string, unknown> {
  const normalizedInput = applyStrictRequiredKeyRename(value, unwrapped);
  const out: Record<string, unknown> = {};
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

  const properties = itemSchema.properties;
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
  const length = lengths[0];
  if (length < 2) {
    return null;
  }

  const zipped: Record<string, unknown>[] = [];
  for (let index = 0; index < length; index += 1) {
    const item: Record<string, unknown> = {};
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
    const singleKey = keys[0];
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
  const first = value[0];
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

  // Coerce primitive scalars to string when schema explicitly expects a string.
  const primitiveString = coercePrimitiveToString(value, schemaType);
  if (primitiveString !== null) {
    return primitiveString;
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

  // Handle object wrappers when schema expects a primitive value.
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isPrimitiveSchemaType(schemaType)
  ) {
    const primitiveResult = coerceObjectToPrimitive(
      value as Record<string, unknown>,
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

    return coerceArrayValue(value, prefixItems, itemsSchema);
  }

  return value;
}
