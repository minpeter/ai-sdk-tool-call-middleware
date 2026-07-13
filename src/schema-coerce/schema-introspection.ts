import { getPatternSchemasForKey } from "./safe-pattern-regex";

export function unwrapJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const s = schema as Record<string, unknown>;
  if ("jsonSchema" in s) {
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
  const { required } = s;
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
  const { type } = s;
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
export function schemaHasProperty(
  schema: unknown,
  key: string,
  depth = 0
): boolean {
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

export function schemaIsUnconstrained(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped == null || unwrapped === true) {
    return true;
  }
  if (typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return false;
  }
  return Object.keys(unwrapped).length === 0;
}
