export const NUMERIC_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export const DIGIT_KEY_REGEX = /^\d+$/;
const WHITESPACE_REGEX = /\s+/g;
const HAS_WHITESPACE_REGEX = /\s/;
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';

export type PrimitiveSchemaType = "string" | "number" | "integer" | "boolean";

export function isPrimitiveSchemaType(
  schemaType: string | undefined
): schemaType is PrimitiveSchemaType {
  return (
    schemaType === "string" ||
    schemaType === "number" ||
    schemaType === "integer" ||
    schemaType === "boolean"
  );
}

export function isPrimitiveMatchForSchemaType(
  value: unknown,
  schemaType: PrimitiveSchemaType
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

export function coerceStringToPrimitive(
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

export function coercePrimitiveToString(
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

/**
 * Conservative enum canonicalization for whitespace-only differences.
 */
export function coerceStringByEnumWhitespace(
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
