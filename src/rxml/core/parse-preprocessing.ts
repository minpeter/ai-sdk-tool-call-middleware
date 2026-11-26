import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { RXMLDuplicateStringTagError } from "../errors/types";
import { getPropertySchema } from "../schema/coercion";
import {
  countTagOccurrences,
  findAllInnerRanges,
  findFirstTopLevelRange,
} from "../schema/extraction";
import { unescapeXml } from "../utils/helpers";
import type { ParseOptions } from "./types";

const WHITESPACE_REGEX = /\s/;
const NUMERIC_STRING_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function getTopLevelStringProps(s: unknown): Set<string> {
  const set = new Set<string>();
  const unwrapped = unwrapJsonSchema(s);
  if (unwrapped && typeof unwrapped === "object") {
    const props = (unwrapped as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    if (props && typeof props === "object") {
      for (const [k, v] of Object.entries(props)) {
        if (getSchemaType(v) === "string") {
          set.add(k);
        }
      }
    }
  }
  return set;
}

function tryConvertToNumber(val: unknown): unknown {
  if (typeof val !== "string") {
    return val;
  }
  const trimmed = val.trim();
  if (NUMERIC_STRING_REGEX.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return trimmed;
}

function processItemValue(item: unknown, textNodeName: string): unknown {
  let currentVal: unknown = item;
  if (item && typeof item === "object" && Object.hasOwn(item, textNodeName)) {
    currentVal = (item as Record<string, unknown>)[textNodeName];
  }
  const trimmed =
    typeof currentVal === "string" ? currentVal.trim() : currentVal;
  return tryConvertToNumber(trimmed);
}

export function processItemWrapper(
  itemValue: unknown,
  textNodeName: string
): unknown {
  if (Array.isArray(itemValue)) {
    return itemValue.map((item) => processItemValue(item, textNodeName));
  }
  const trimmed = typeof itemValue === "string" ? itemValue.trim() : itemValue;
  return tryConvertToNumber(trimmed);
}

export function deepDecodeStringsBySchema(
  input: unknown,
  schema: unknown
): unknown {
  if (input == null || schema == null) {
    return input;
  }

  const type = getSchemaType(schema);

  if (type === "string" && typeof input === "string") {
    return unescapeXml(input);
  }

  if (type === "array" && Array.isArray(input)) {
    const unwrapped = unwrapJsonSchema(schema) as
      | { items?: unknown }
      | undefined;
    const itemSchema = unwrapped?.items ?? {};
    return input.map((item) => deepDecodeStringsBySchema(item, itemSchema));
  }

  if (type === "object" && input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const childSchema = getPropertySchema(schema, key);
      out[key] = deepDecodeStringsBySchema(obj[key], childSchema);
    }
    return out;
  }

  if (typeof input === "string") {
    return unescapeXml(input);
  }
  return input;
}

function skipXmlPrologConstruct(s: string, lt: number): number | null {
  const next = s[lt + 1];
  if (next === "?") {
    const end = s.indexOf("?>", lt + 2);
    return end === -1 ? s.length : end + 2;
  }
  if (next !== "!") {
    return null;
  }
  if (s.startsWith("!--", lt + 2)) {
    const end = s.indexOf("-->", lt + 5);
    return end === -1 ? s.length : end + 3;
  }
  if (s.startsWith("![CDATA[", lt + 2)) {
    const end = s.indexOf("]]>", lt + 9);
    return end === -1 ? s.length : end + 3;
  }
  const end = s.indexOf(">", lt + 2);
  return end === -1 ? s.length : end + 1;
}

const ROOT_TAG_END_CHARS = new Set([" ", "\n", "\r", "\t", "/", ">"]);

function findRootTagStart(s: string): { rootName: string; rootStart: number } {
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    const skipped = skipXmlPrologConstruct(s, lt);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    if (s[lt + 1] === "/") {
      break;
    }
    let j = lt + 1;
    while (j < s.length && !ROOT_TAG_END_CHARS.has(s[j] ?? "")) {
      j += 1;
    }
    return { rootStart: lt, rootName: s.slice(lt + 1, j) };
  }
  return { rootStart: -1, rootName: "" };
}

export function unwrapSyntheticRootXml(
  xmlInner: string,
  schema: unknown
): string {
  const s = xmlInner.trim();
  if (!(s.startsWith("<") && s.endsWith(">"))) {
    return s;
  }

  const { rootStart, rootName } = findRootTagStart(s);
  if (!(rootStart === 0 && rootName)) {
    return s;
  }

  const range = findFirstTopLevelRange(s, rootName);
  if (!range) {
    return s;
  }

  let fullEnd = range.end + `</${rootName}>`.length;
  const closeHead = s.indexOf(`</${rootName}`, range.end);
  if (closeHead === range.end) {
    let p = closeHead + 2 + rootName.length;
    while (p < s.length && WHITESPACE_REGEX.test(s[p])) {
      p += 1;
    }
    if (s[p] === ">") {
      fullEnd = p + 1;
    }
  }

  if (fullEnd !== s.length) {
    return s;
  }

  const unwrapped = unwrapJsonSchema(schema);
  const schemaProps =
    unwrapped && typeof unwrapped === "object"
      ? ((unwrapped as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined)
      : undefined;

  if (schemaProps && !Object.hasOwn(schemaProps, rootName)) {
    return s.slice(range.start, range.end);
  }
  return s;
}

export function detectDuplicateTopLevelStringTags(
  actualXmlInner: string,
  topLevelStringProps: Set<string>,
  throwDup: boolean,
  onError?: ParseOptions["onError"]
): Set<string> {
  const duplicateKeys = new Set<string>();
  for (const key of topLevelStringProps) {
    const excludeRanges: Array<{ start: number; end: number }> = [];
    for (const other of topLevelStringProps) {
      if (other === key) {
        continue;
      }
      const range = findFirstTopLevelRange(actualXmlInner, other);
      if (range) {
        excludeRanges.push(range);
      }
    }

    const occurrences = countTagOccurrences(
      actualXmlInner,
      key,
      excludeRanges,
      true
    );

    if (occurrences > 0 && throwDup) {
      throw new RXMLDuplicateStringTagError(
        `Duplicate string tags for <${key}> detected`
      );
    }
    if (occurrences > 0 && !throwDup) {
      duplicateKeys.add(key);
      if (onError) {
        onError(
          `RXML: Duplicate string tags for <${key}> detected; using first occurrence.`,
          { tag: key, occurrences }
        );
      }
    }
  }
  return duplicateKeys;
}

export function shieldStringTagsWithPlaceholders(
  actualXmlInner: string,
  deepStringTypedProps: Set<string>,
  onError?: ParseOptions["onError"]
): { originalContentMap: Map<string, string>; xmlInnerForParsing: string } {
  const originalContentMap = new Map<string, string>();
  try {
    const ranges: Array<{ start: number; end: number; key: string }> = [];
    for (const key of deepStringTypedProps) {
      const innerRanges = findAllInnerRanges(actualXmlInner, key);
      for (const r of innerRanges) {
        if (r.end > r.start) {
          ranges.push({ ...r, key });
        }
      }
    }

    if (ranges.length === 0) {
      return { originalContentMap, xmlInnerForParsing: actualXmlInner };
    }

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let rebuilt = "";
    let cursor = 0;
    for (const r of sorted) {
      if (r.start < cursor) {
        continue;
      }
      if (cursor < r.start) {
        rebuilt += actualXmlInner.slice(cursor, r.start);
      }
      const placeholder = `__RXML_PLACEHOLDER_${r.key}_${r.start}_${r.end}__`;
      const originalContent = actualXmlInner.slice(r.start, r.end);
      originalContentMap.set(placeholder, originalContent);
      rebuilt += placeholder;
      cursor = r.end;
    }
    if (cursor < actualXmlInner.length) {
      rebuilt += actualXmlInner.slice(cursor);
    }
    return { originalContentMap, xmlInnerForParsing: rebuilt };
  } catch (error) {
    if (onError) {
      onError(
        "RXML: Failed to replace string placeholders, falling back to original XML.",
        { error }
      );
    }
    return { originalContentMap, xmlInnerForParsing: actualXmlInner };
  }
}
