import { getPatternSchemasForKey } from "./safe-pattern-regex";
import { getSchemaType } from "./schema-introspection";

const SNAKE_SEGMENT_REGEX = /_([a-zA-Z0-9])/g;
const CAMEL_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g;
const LEADING_UNDERSCORES_REGEX = /^_+/;

interface StrictObjectSchemaInfo {
  patternProperties?: Record<string, unknown>;
  properties: Record<string, unknown>;
  required: string[];
}

export function getStrictObjectSchemaInfo(
  unwrapped: Record<string, unknown>
): StrictObjectSchemaInfo | null {
  if (getSchemaType(unwrapped) !== "object") {
    return null;
  }
  if (unwrapped.additionalProperties !== false) {
    return null;
  }

  const { properties } = unwrapped;
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

function findSingleMatchingUnexpectedKey(
  unexpectedKeys: string[],
  matches: (key: string) => boolean
): string | null {
  const matchingKeys = unexpectedKeys.filter(matches);
  return matchingKeys.length === 1 ? (matchingKeys[0] ?? null) : null;
}

function applySingularPluralRequiredKeyRename(
  input: Record<string, unknown>,
  schemaInfo: StrictObjectSchemaInfo
): Record<string, unknown> | null {
  const { missingRequired, unexpectedKeys } = computeMissingAndUnexpectedKeys(
    input,
    schemaInfo
  );

  if (missingRequired.length !== 1) {
    return null;
  }

  const [targetKey] = missingRequired;
  if (!Object.hasOwn(schemaInfo.properties, targetKey)) {
    return null;
  }
  const sourceKey = findSingleMatchingUnexpectedKey(unexpectedKeys, (key) =>
    isSingularPluralPair(targetKey, key)
  );
  if (sourceKey === null) {
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

  if (missingRequired.length !== 1) {
    return null;
  }

  const [targetKey] = missingRequired;
  if (!Object.hasOwn(schemaInfo.properties, targetKey)) {
    return null;
  }
  const sourceKey = findSingleMatchingUnexpectedKey(unexpectedKeys, (key) =>
    isCaseStylePair(targetKey, key)
  );
  if (sourceKey === null) {
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

export function applyStrictRequiredKeyRename(
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
