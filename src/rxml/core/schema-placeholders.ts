import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { RXMLDuplicateStringTagError } from "../errors/types";
import {
  countTagOccurrences,
  findAllInnerRanges,
  findFirstTopLevelRange,
} from "../schema/extraction";
import type { ParseOptions } from "./types";

export interface ShieldedXml {
  readonly content: string;
  readonly originals: Map<string, string>;
}

export function getTopLevelStringProps(schema: unknown): Set<string> {
  const result = new Set<string>();
  const unwrapped = unwrapJsonSchema(schema);
  if (!(unwrapped && typeof unwrapped === "object")) {
    return result;
  }
  const properties = (unwrapped as Record<string, unknown>).properties as
    | Record<string, unknown>
    | undefined;
  if (!properties || typeof properties !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(properties)) {
    if (getSchemaType(value) === "string") {
      result.add(key);
    }
  }
  return result;
}

function rangesForOtherProperties(
  xml: string,
  key: string,
  stringProperties: ReadonlySet<string>
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const other of stringProperties) {
    if (other === key) {
      continue;
    }
    const range = findFirstTopLevelRange(xml, other);
    if (range !== undefined) {
      ranges.push(range);
    }
  }
  return ranges;
}

export function findDuplicateStringKeys(
  xml: string,
  stringProperties: ReadonlySet<string>,
  options: ParseOptions
): Set<string> {
  const duplicateKeys = new Set<string>();
  const shouldThrow = options.throwOnDuplicateStringTags ?? true;
  for (const key of stringProperties) {
    const occurrences = countTagOccurrences(
      xml,
      key,
      rangesForOtherProperties(xml, key, stringProperties),
      true
    );
    if (occurrences > 0 && shouldThrow) {
      throw new RXMLDuplicateStringTagError(
        `Duplicate string tags for <${key}> detected`
      );
    }
    if (occurrences > 0) {
      duplicateKeys.add(key);
      options.onError?.(
        `RXML: Duplicate string tags for <${key}> detected; using first occurrence.`,
        { tag: key, occurrences }
      );
    }
  }
  return duplicateKeys;
}

function findStringContentRanges(
  xml: string,
  stringProperties: ReadonlySet<string>
): Array<{ start: number; end: number; key: string }> {
  const ranges: Array<{ start: number; end: number; key: string }> = [];
  for (const key of stringProperties) {
    for (const range of findAllInnerRanges(xml, key)) {
      if (range.end > range.start) {
        ranges.push({ ...range, key });
      }
    }
  }
  return ranges;
}

export function shieldStringContent(
  xml: string,
  stringProperties: ReadonlySet<string>,
  options: ParseOptions
): ShieldedXml {
  const originals = new Map<string, string>();
  try {
    const ranges = findStringContentRanges(xml, stringProperties);
    if (ranges.length === 0) {
      return { content: xml, originals };
    }
    let content = "";
    let cursor = 0;
    for (const range of ranges.sort(
      (left, right) => left.start - right.start
    )) {
      if (range.start < cursor) {
        continue;
      }
      if (cursor < range.start) {
        content += xml.slice(cursor, range.start);
      }
      const placeholder = `__RXML_PLACEHOLDER_${range.key}_${range.start}_${range.end}__`;
      originals.set(placeholder, xml.slice(range.start, range.end));
      content += placeholder;
      cursor = range.end;
    }
    if (cursor < xml.length) {
      content += xml.slice(cursor);
    }
    return { content, originals };
  } catch (error) {
    options.onError?.(
      "RXML: Failed to replace string placeholders, falling back to original XML.",
      { error }
    );
    return { content: xml, originals };
  }
}
