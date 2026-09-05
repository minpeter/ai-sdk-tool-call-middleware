import type { JSONSchema7 } from "@ai-sdk/provider";
import { getSchemaType } from "../../schema-coerce";
import type { RxmlValue } from "../builders/stringify";
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

type RxmlRecord = Record<string, RxmlValue>;
type ParsedSchema = JSONSchema7 | boolean | undefined;

type Resolution =
  | { readonly handled: false }
  | { readonly handled: true; readonly value: RxmlValue };

interface PropertyContext {
  readonly duplicateKeys: ReadonlySet<string>;
  readonly options: ParseOptions;
  readonly originalContent: ReadonlyMap<string, string>;
  readonly schema: ParsedSchema;
  readonly textNodeName: string;
  readonly xml: string;
}

function isRxmlArray(value: RxmlValue): value is readonly RxmlValue[] {
  return Array.isArray(value);
}

function isRxmlRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryConvertToNumber(value: RxmlValue): RxmlValue {
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

function processItemValue(item: RxmlValue, textNodeName: string): RxmlValue {
  const current =
    isRxmlRecord(item) && Object.hasOwn(item, textNodeName)
      ? item[textNodeName]
      : item;
  const trimmed = typeof current === "string" ? current.trim() : current;
  return tryConvertToNumber(trimmed);
}

function processItemWrapper(value: RxmlValue, textNodeName: string): RxmlValue {
  if (isRxmlArray(value)) {
    return value.map((item) => processItemValue(item, textNodeName));
  }
  const trimmed = typeof value === "string" ? value.trim() : value;
  return tryConvertToNumber(trimmed);
}

function resolveDuplicateString(
  key: string,
  value: RxmlValue,
  context: PropertyContext
): Resolution {
  if (!(context.duplicateKeys.has(key) && isRxmlArray(value))) {
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
  value: RxmlValue,
  textNodeName: string
): string | undefined {
  if (typeof value === "string" && value.startsWith("__RXML_PLACEHOLDER_")) {
    return value;
  }
  if (!(isRxmlRecord(value) && Object.hasOwn(value, textNodeName))) {
    return;
  }
  const text = value[textNodeName];
  return typeof text === "string" && text.startsWith("__RXML_PLACEHOLDER_")
    ? text
    : undefined;
}

function resolveScalarString(
  key: string,
  value: RxmlValue,
  context: PropertyContext
): Resolution {
  if (isRxmlArray(value)) {
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

function stringFromItem(item: RxmlValue, textNodeName: string): string {
  if (isRxmlRecord(item) && Object.hasOwn(item, textNodeName)) {
    const text = item[textNodeName];
    return typeof text === "string" ? text : String(text);
  }
  return typeof item === "string" ? item : String(item);
}

function processStringArray(
  key: string,
  value: readonly RxmlValue[],
  context: PropertyContext
): RxmlValue {
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

function processObject(
  objectValue: RxmlRecord,
  textNodeName: string
): RxmlValue {
  if (Object.hasOwn(objectValue, textNodeName)) {
    return objectValue[textNodeName];
  }
  const keys = Object.keys(objectValue);
  if (keys.length === 1 && keys[0] === "item") {
    return processItemWrapper(objectValue.item, textNodeName);
  }
  if (!(keys.length > 0 && keys.every((key) => DIGIT_KEY_REGEX.test(key)))) {
    return objectValue;
  }
  const indices = keys
    .map((key) => Number.parseInt(key, 10))
    .sort((left, right) => left - right);
  return indices[0] === 0 &&
    indices.every((index, position) => index === position)
    ? processIndexedTuple(objectValue, textNodeName)
    : objectValue;
}

function processProperty(
  key: string,
  value: RxmlValue,
  context: PropertyContext
): RxmlValue {
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
  if (isRxmlArray(value)) {
    return propertyType === "string"
      ? processStringArray(key, value, context)
      : processArrayContent(value, propertySchema, context.textNodeName);
  }
  const processed = isRxmlRecord(value)
    ? processObject(value, context.textNodeName)
    : value;
  return typeof processed === "string" ? processed.trim() : processed;
}

export function processParsedProperties(
  parsed: RxmlRecord,
  context: PropertyContext
): RxmlRecord {
  const result: RxmlRecord = Object.create(null);
  for (const key of Object.keys(parsed)) {
    result[key] = processProperty(key, parsed[key], context);
  }
  return result;
}

export function backfillStringProperties(
  args: RxmlRecord,
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
