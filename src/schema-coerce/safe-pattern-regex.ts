import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";
import { hasAdjacentRepeatedQuantifiedAtoms } from "./safe-pattern-atoms";
import { hasNestedQuantifierRisk } from "./safe-pattern-nesting";

const REGEX_BACKREFERENCE_REGEX = /\\(?:[1-9]|k<)/;
const MAX_PATTERN_PROPERTY_REGEX_LENGTH = 128;

export function compileSafePatternPropertyRegex(
  pattern: string
): RegExp | null {
  if (
    pattern.length > MAX_PATTERN_PROPERTY_REGEX_LENGTH ||
    REGEX_BACKREFERENCE_REGEX.test(pattern) ||
    hasNestedQuantifierRisk(pattern) ||
    hasAdjacentRepeatedQuantifiedAtoms(pattern)
  ) {
    return null;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Gets all schemas from patternProperties that match the given key.
 *
 * @param patternProperties - The patternProperties object from a JSON Schema
 * @param key - The property key to match against patterns
 * @returns Array of schemas whose patterns match the key
 *
 * @remarks
 * Schema patterns are compiled only after the bounded risk scan above.
 */
type PatternSchema = JSONSchema7Definition;
type PatternProperties = NonNullable<JSONSchema7["patternProperties"]>;

function isPatternProperties(
  value: JSONSchema7["patternProperties"] | null
): value is PatternProperties {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (schema): schema is JSONSchema7Definition =>
      typeof schema === "boolean" ||
      (schema !== null && typeof schema === "object" && !Array.isArray(schema))
  );
}

export function getPatternSchemasForKey(
  patternProperties: JSONSchema7["patternProperties"] | null,
  key: string
): PatternSchema[] {
  if (!isPatternProperties(patternProperties)) {
    return [];
  }
  const schemas: PatternSchema[] = [];
  for (const [pattern, schema] of Object.entries(patternProperties)) {
    const regex = compileSafePatternPropertyRegex(pattern);
    if (regex?.test(key)) {
      schemas.push(schema);
    }
  }
  return schemas;
}
