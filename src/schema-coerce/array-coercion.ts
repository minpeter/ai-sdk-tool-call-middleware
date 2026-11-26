import { parseLooseStructuredString } from "./loose-structured-string";
import {
  DIGIT_KEY_REGEX,
  isPrimitiveMatchForSchemaType,
  isPrimitiveSchemaType,
} from "./primitive-coercion";
import {
  getSchemaType,
  schemaHasProperty,
  schemaIsUnconstrained,
  unwrapJsonSchema,
} from "./schema-introspection";

const NEWLINE_SPLIT_REGEX = /\n+/;
const COMMA_SPLIT_REGEX = /,\s*/;

export type SchemaCoerceFn = (value: unknown, schema?: unknown) => unknown;

export function coerceStringToArray(
  s: string,
  unwrapped: Record<string, unknown>,
  coerceValue: SchemaCoerceFn
): unknown {
  const prefixItems = Array.isArray(unwrapped.prefixItems)
    ? (unwrapped.prefixItems as unknown[])
    : undefined;
  const itemsSchema = unwrapped.items as unknown;

  const coerceArrayItems = (arr: unknown[]): unknown => {
    if (prefixItems && arr.length === prefixItems.length) {
      return arr.map((v, i) => coerceValue(v, prefixItems[i]));
    }
    return arr.map((v) => coerceValue(v, itemsSchema));
  };

  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return coerceArrayItems(arr);
    }
  } catch {
    const parsed = parseLooseStructuredString(s);
    if (Array.isArray(parsed)) {
      return coerceArrayItems(parsed);
    }

    const csv = s.includes("\n")
      ? s.split(NEWLINE_SPLIT_REGEX)
      : s.split(COMMA_SPLIT_REGEX);
    const trimmed = csv.map((x) => x.trim()).filter((x) => x.length > 0);
    if (prefixItems && trimmed.length === prefixItems.length) {
      return trimmed.map((x, i) => coerceValue(x, prefixItems[i]));
    }
    return trimmed.map((x) => coerceValue(x, itemsSchema));
  }
  return null;
}

function coerceArrayToArray(
  value: unknown[],
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
): unknown[] {
  if (prefixItems && value.length === prefixItems.length) {
    return value.map((v, i) => coerceValue(v, prefixItems[i]));
  }
  return value.map((v) => coerceValue(v, itemsSchema));
}

function coercePrimitiveWrappedObject(
  value: Record<string, unknown>,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
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

  const coerced = coerceValue(singleValue, itemsSchema);
  return isPrimitiveMatchForSchemaType(coerced, schemaType) ? coerced : null;
}

function coerceParallelArraysObjectToArray(
  maybe: Record<string, unknown>,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
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
  if (
    getSchemaType(itemSchema) !== "object" ||
    itemSchema.additionalProperties !== false
  ) {
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
  if (
    entries.length < 2 ||
    !entries.every(([, value]) => Array.isArray(value)) ||
    !entries.every(([key]) => Object.hasOwn(propertyMap, key)) ||
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

  return coerceArrayToArray(zipped, prefixItems, itemsSchema, coerceValue);
}

function coerceSingleKeyObjectToArray(
  singleValue: unknown,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
): unknown[] | null {
  if (Array.isArray(singleValue)) {
    return singleValue.map((v) => coerceValue(v, itemsSchema));
  }
  if (singleValue && typeof singleValue === "object") {
    const primitiveWrapped = coercePrimitiveWrappedObject(
      singleValue as Record<string, unknown>,
      itemsSchema,
      coerceValue
    );
    if (primitiveWrapped !== null) {
      return [primitiveWrapped];
    }
    return [coerceValue(singleValue, itemsSchema)];
  }
  return null;
}

function coerceObjectToArray(
  maybe: Record<string, unknown>,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
): unknown {
  if (Object.hasOwn(maybe, "item")) {
    const items = maybe.item as unknown;
    const arr = Array.isArray(items) ? items : [items];
    return coerceArrayToArray(arr, prefixItems, itemsSchema, coerceValue);
  }

  const keys = Object.keys(maybe);

  if (keys.length > 0 && keys.every((k) => DIGIT_KEY_REGEX.test(k))) {
    const arr = keys.sort((a, b) => Number(a) - Number(b)).map((k) => maybe[k]);
    return coerceArrayToArray(arr, prefixItems, itemsSchema, coerceValue);
  }

  const parallelArrays = coerceParallelArraysObjectToArray(
    maybe,
    prefixItems,
    itemsSchema,
    coerceValue
  );
  if (parallelArrays !== null) {
    return parallelArrays;
  }

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
        itemsSchema,
        coerceValue
      );
      if (result !== null) {
        return result;
      }
    }
  }

  return null;
}

function coercePrimitiveToArray(
  value: unknown,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
): unknown[] {
  if (prefixItems && prefixItems.length > 0) {
    return [coerceValue(value, prefixItems[0])];
  }
  return [coerceValue(value, itemsSchema)];
}

export function coerceArrayValue(
  value: unknown,
  prefixItems: unknown[] | undefined,
  itemsSchema: unknown,
  coerceValue: SchemaCoerceFn
): unknown {
  if (Array.isArray(value)) {
    return coerceArrayToArray(value, prefixItems, itemsSchema, coerceValue);
  }

  if (value && typeof value === "object") {
    const result = coerceObjectToArray(
      value as Record<string, unknown>,
      prefixItems,
      itemsSchema,
      coerceValue
    );
    if (result !== null) {
      return result;
    }
    if (getSchemaType(itemsSchema) === "array") {
      return [value];
    }
    return [coerceValue(value, itemsSchema)];
  }

  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return coercePrimitiveToArray(value, prefixItems, itemsSchema, coerceValue);
  }

  return [value];
}
