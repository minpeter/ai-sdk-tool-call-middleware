import type { JSONSchema7 } from "@ai-sdk/provider";
import { unwrapJsonSchema } from "../../schema-coerce";
import type { RxmlValue } from "../builders/stringify";
import { findFirstTopLevelRange } from "../schema/extraction";

const TAG_NAME_END_REGEX = /[\s/>]/;
const WHITESPACE_REGEX = /\s/;

type ParsedSchema = JSONSchema7 | boolean | undefined;
interface RxmlRecord {
  readonly [key: string]: RxmlValue;
}

function getSchemaProperties(schema: ParsedSchema): JSONSchema7["properties"] {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") {
    return;
  }
  const { properties } = unwrapped;
  return properties && typeof properties === "object" ? properties : undefined;
}

function skipLeadingConstruct(
  xml: string,
  opening: number,
  marker: string | undefined
): number | undefined {
  if (marker === "?") {
    const end = xml.indexOf("?>", opening + 2);
    return end === -1 ? xml.length : end + 2;
  }
  if (marker !== "!") {
    return;
  }
  let terminator = ">";
  let offset = 2;
  if (xml.startsWith("!--", opening + 2)) {
    terminator = "-->";
    offset = 5;
  } else if (xml.startsWith("![CDATA[", opening + 2)) {
    terminator = "]]>";
    offset = 9;
  }
  const end = xml.indexOf(terminator, opening + offset);
  return end === -1 ? xml.length : end + terminator.length;
}

function findRootName(xml: string): string | undefined {
  let position = 0;
  while (position < xml.length) {
    const opening = xml.indexOf("<", position);
    if (opening === -1) {
      return;
    }
    const marker = xml[opening + 1];
    const nextPosition = skipLeadingConstruct(xml, opening, marker);
    if (nextPosition !== undefined) {
      position = nextPosition;
      continue;
    }
    if (marker === "/") {
      return;
    }
    let end = opening + 1;
    while (end < xml.length && !TAG_NAME_END_REGEX.test(xml[end])) {
      end += 1;
    }
    return opening === 0 ? xml.slice(opening + 1, end) : undefined;
  }
}

function fullRootEnd(xml: string, rootName: string, innerEnd: number): number {
  const closeHead = xml.indexOf(`</${rootName}`, innerEnd);
  if (closeHead !== innerEnd) {
    return innerEnd + `</${rootName}>`.length;
  }
  let position = closeHead + 2 + rootName.length;
  while (position < xml.length && WHITESPACE_REGEX.test(xml[position])) {
    position += 1;
  }
  return xml[position] === ">"
    ? position + 1
    : innerEnd + `</${rootName}>`.length;
}

export function normalizeDocumentRoot(
  xmlInner: string,
  schema: ParsedSchema
): string {
  const xml = xmlInner.trim();
  if (!(xml.startsWith("<") && xml.endsWith(">"))) {
    return xml;
  }
  const rootName = findRootName(xml);
  if (rootName === undefined) {
    return xml;
  }
  const range = findFirstTopLevelRange(xml, rootName);
  const schemaProperties = getSchemaProperties(schema);
  if (
    range === undefined ||
    fullRootEnd(xml, rootName, range.end) !== xml.length ||
    !schemaProperties ||
    Object.hasOwn(schemaProperties, rootName)
  ) {
    return xml;
  }
  return xml.slice(range.start, range.end);
}

export function unwrapUnexpectedRoot(
  args: RxmlRecord,
  schema: ParsedSchema
): RxmlValue {
  const keys = Object.keys(args);
  if (keys.length !== 1) {
    return args;
  }
  const [rootKey] = keys;
  const schemaProperties = getSchemaProperties(schema);
  if (!schemaProperties || Object.hasOwn(schemaProperties, rootKey)) {
    return args;
  }
  return args[rootKey];
}
