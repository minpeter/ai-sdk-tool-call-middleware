import { unwrapJsonSchema } from "../../schema-coerce";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeMatches(schemaType: string, value: unknown): boolean {
  if (schemaType === "object") {
    return isRecord(value);
  }
  if (schemaType === "array") {
    return Array.isArray(value);
  }
  if (schemaType === "string") {
    return typeof value === "string";
  }
  if (schemaType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (schemaType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (schemaType === "boolean") {
    return typeof value === "boolean";
  }
  if (schemaType === "null") {
    return value === null;
  }
  return true;
}

function schemaTypeMatches(schemaType: unknown, value: unknown): boolean {
  if (typeof schemaType === "string") {
    return jsonTypeMatches(schemaType, value);
  }
  if (!Array.isArray(schemaType)) {
    return true;
  }
  return schemaType.some(
    (entry) => typeof entry === "string" && jsonTypeMatches(entry, value)
  );
}

function requiredPropertiesArePresent(
  schema: Record<string, unknown>,
  value: unknown
): boolean {
  if (!Array.isArray(schema.required)) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return schema.required.every(
    (key) => typeof key !== "string" || Object.hasOwn(value, key)
  );
}

function declaredPropertiesAcceptValues(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): boolean {
  if (!(isRecord(schema.properties) && isRecord(value))) {
    return true;
  }
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (propertySchema === false) {
      return false;
    }
    if (!schemaAcceptsValue(propertySchema, value[key], new Set(seen))) {
      return false;
    }
  }
  return true;
}

function schemaAcceptsAllOf(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): boolean {
  if (!Array.isArray(schema.allOf)) {
    return true;
  }
  return schema.allOf.every((variant) =>
    schemaAcceptsValue(variant, value, new Set(seen))
  );
}

function schemaAcceptsAnyOf(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): boolean {
  if (!Array.isArray(schema.anyOf)) {
    return true;
  }
  return schema.anyOf.some((variant) =>
    schemaAcceptsValue(variant, value, new Set(seen))
  );
}

function schemaAcceptsOneOf(
  schema: Record<string, unknown>,
  value: unknown,
  seen: Set<object>
): boolean {
  if (!Array.isArray(schema.oneOf)) {
    return true;
  }
  let matches = 0;
  for (const variant of schema.oneOf) {
    if (schemaAcceptsValue(variant, value, new Set(seen))) {
      matches += 1;
    }
  }
  return matches === 1;
}

function schemaAcceptsValue(
  schema: unknown,
  value: unknown,
  seen: Set<object>
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return false;
  }
  if (unwrapped === true || !isRecord(unwrapped)) {
    return true;
  }
  if (seen.has(unwrapped)) {
    return true;
  }
  seen.add(unwrapped);
  return (
    schemaTypeMatches(unwrapped.type, value) &&
    requiredPropertiesArePresent(unwrapped, value) &&
    declaredPropertiesAcceptValues(unwrapped, value, seen) &&
    schemaAcceptsAllOf(unwrapped, value, seen) &&
    schemaAcceptsAnyOf(unwrapped, value, seen) &&
    schemaAcceptsOneOf(unwrapped, value, seen)
  );
}

function addPropertyNames(schema: unknown, names: Set<string>): void {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped)) {
    return;
  }
  const falsePropertyNames = new Set<string>();
  if (isRecord(unwrapped.properties)) {
    for (const [key, propertySchema] of Object.entries(unwrapped.properties)) {
      if (propertySchema === false) {
        falsePropertyNames.add(key);
      } else {
        names.add(key);
      }
    }
  }
  if (Array.isArray(unwrapped.required)) {
    for (const key of unwrapped.required) {
      if (typeof key === "string" && !falsePropertyNames.has(key)) {
        names.add(key);
      }
    }
  }
  if (Array.isArray(unwrapped.allOf)) {
    for (const variant of unwrapped.allOf) {
      addPropertyNames(variant, names);
    }
  }
}

function schemaSelectionScore(schema: unknown, value: unknown): number {
  if (!isRecord(value)) {
    return 0;
  }
  const names = new Set<string>();
  addPropertyNames(schema, names);
  let score = 0;
  for (const name of names) {
    if (Object.hasOwn(value, name)) {
      score += 1;
    }
  }
  return score;
}

export function selectSchemaVariant(
  variants: unknown,
  value: unknown,
  seen: Set<object>
): unknown {
  if (!Array.isArray(variants)) {
    return;
  }

  let bestVariant: unknown;
  let bestScore = 0;
  for (const variant of variants) {
    if (!schemaAcceptsValue(variant, value, new Set(seen))) {
      continue;
    }
    const score = schemaSelectionScore(variant, value);
    if (bestVariant === undefined || score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }
  if (bestVariant !== undefined) {
    return bestVariant;
  }

  for (const variant of variants) {
    const score = schemaSelectionScore(variant, value);
    if (score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }
  return bestVariant;
}
