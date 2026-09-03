import { getSchemaType } from "../../schema-coerce";
import { RXMLDuplicateStringTagError } from "../errors/types";
import {
  getPropertySchema,
  processArrayContent,
  processIndexedTuple,
} from "../schema/coercion";
import { extractRawInner } from "../schema/extraction";
import type { ParseOptions } from "./types";

const DIGIT_KEY_REGEX = /^\d+$/;
const NUMERIC_STRING_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type Resolution =
  | { readonly handled: false }
  | { readonly handled: true; readonly value: unknown };

interface PropertyContext {
  readonly duplicateKeys: ReadonlySet<string>;
  readonly options: ParseOptions;
  readonly originalContent: ReadonlyMap<string, string>;
  readonly schema: unknown;
  readonly textNodeName: string;
  readonly xml: string;
}

function tryConvertToNumber(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!NUMERIC_STRING_REGEX.test(trimmed)) {
    return trimmed;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : trimmed;
}

function processItemValue(item: unknown, textNodeName: string): unknown {
  const current =
    item && typeof item === "object" && Object.hasOwn(item, textNodeName)
      ? (item as Record<string, unknown>)[textNodeName]
      : item;
  const trimmed = typeof current === "string" ? current.trim() : current;
  return tryConvertToNumber(trimmed);
}

function processItemWrapper(value: unknown, textNodeName: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => processItemValue(item, textNodeName));
  }
  const trimmed = typeof value === "string" ? value.trim() : value;
  return tryConvertToNumber(trimmed);
}

function resolveDuplicateString(
  key: string,
  value: unknown,
  context: PropertyContext
): Resolution {
  if (!(context.duplicateKeys.has(key) && Array.isArray(value))) {
    return { handled: false };
  }
  const [firstValue] = value;
  if (
    typeof firstValue === "string" &&
    firstValue.startsWith("__RXML_PLACEHOLDER_")
  ) {
    const original = context.originalContent.get(firstValue);
    return original === undefined
      ? { handled: false }
      : { handled: true, value: original };
  }
  return { handled: true, value: firstValue };
}

function placeholderKey(
  value: unknown,
  textNodeName: string
): string | undefined {
  if (typeof value === "string" && value.startsWith("__RXML_PLACEHOLDER_")) {
    return value;
  }
  if (
    !(value && typeof value === "object" && Object.hasOwn(value, textNodeName))
  ) {
    return;
  }
  const text = (value as Record<string, unknown>)[textNodeName];
  return typeof text === "string" && text.startsWith("__RXML_PLACEHOLDER_")
    ? text
    : undefined;
}

function resolveScalarString(
  key: string,
  value: unknown,
  context: PropertyContext
): Resolution {
  if (Array.isArray(value)) {
    return { handled: false };
  }
  const keyForPlaceholder = placeholderKey(value, context.textNodeName);
  if (keyForPlaceholder !== undefined) {
    const original = context.originalContent.get(keyForPlaceholder);
    if (original !== undefined) {
      return { handled: true, value: original };
    }
  }
  const raw = extractRawInner(context.xml, key);
  return typeof raw === "string"
    ? { handled: true, value: raw }
    : { handled: false };
}

function stringFromItem(item: unknown, textNodeName: string): string {
  if (item && typeof item === "object" && Object.hasOwn(item, textNodeName)) {
    const text = (item as Record<string, unknown>)[textNodeName];
    return typeof text === "string" ? text : String(text);
  }
  return typeof item === "string" ? item : String(item);
}

function processStringArray(
  key: string,
  value: unknown[],
  context: PropertyContext
): unknown {
  const mapped = value.map((item) =>
    stringFromItem(item, context.textNodeName)
  );
  const shouldThrow = context.options.throwOnDuplicateStringTags ?? true;
  if (mapped.length > 1 && shouldThrow) {
    throw new RXMLDuplicateStringTagError(
      `Duplicate string tags for <${key}> detected`
    );
  }
  if (mapped.length > 1 && !shouldThrow) {
    context.options.onError?.(
      `RXML: Duplicate string tags for <${key}> detected; using first occurrence.`,
      { tag: key, occurrences: mapped.length }
    );
  }
  return mapped[0] ?? "";
}

function processObject(value: object, textNodeName: string): unknown {
  if (Object.hasOwn(value, textNodeName)) {
    return (value as Record<string, unknown>)[textNodeName];
  }
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue);
  if (keys.length === 1 && keys[0] === "item") {
    return processItemWrapper(objectValue.item, textNodeName);
  }
  if (!(keys.length > 0 && keys.every((key) => DIGIT_KEY_REGEX.test(key)))) {
    return value;
  }
  const indices = keys
    .map((key) => Number.parseInt(key, 10))
    .sort((left, right) => left - right);
  return indices[0] === 0 &&
    indices.every((index, position) => index === position)
    ? processIndexedTuple(objectValue, textNodeName)
    : value;
}

function processProperty(
  key: string,
  value: unknown,
  context: PropertyContext
): unknown {
  const propertySchema = getPropertySchema(context.schema, key);
  const propertyType = getSchemaType(propertySchema);
  if (propertyType === "string") {
    const duplicate = resolveDuplicateString(key, value, context);
    if (duplicate.handled) {
      return duplicate.value;
    }
    const scalar = resolveScalarString(key, value, context);
    if (scalar.handled) {
      return scalar.value;
    }
  }
  if (Array.isArray(value)) {
    return propertyType === "string"
      ? processStringArray(key, value, context)
      : processArrayContent(value, propertySchema, context.textNodeName);
  }
  const processed =
    value && typeof value === "object"
      ? processObject(value, context.textNodeName)
      : value;
  return typeof processed === "string" ? processed.trim() : processed;
}

export function processParsedProperties(
  parsed: Record<string, unknown>,
  context: PropertyContext
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    result[key] = processProperty(key, parsed[key], context);
  }
  return result;
}

export function backfillStringProperties(
  args: Record<string, unknown>,
  stringProperties: ReadonlySet<string>,
  xml: string
): void {
  for (const key of stringProperties) {
    if (Object.hasOwn(args, key)) {
      continue;
    }
    const raw = extractRawInner(xml, key);
    if (typeof raw === "string") {
      args[key] = raw;
    }
  }
}
