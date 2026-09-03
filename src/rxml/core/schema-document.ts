import type { SchemaBoundaryValue } from "../../core/utils/tool-call-object-schema";
import { unwrapJsonSchema } from "../../schema-coerce";
import { findFirstTopLevelRange } from "../schema/extraction";

const TAG_NAME_END_REGEX = /[\s/>]/;
const WHITESPACE_REGEX = /\s/;

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSchemaProperties<Schema>(
  schema: Schema
): SchemaBoundaryRecord | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped)) {
    return;
  }
  return isRecord(unwrapped.properties) ? unwrapped.properties : undefined;
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
  schema: unknown
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
  args: Record<string, unknown>,
  schema: unknown
): Record<string, unknown> {
  const keys = Object.keys(args);
  if (keys.length !== 1) {
    return args;
  }
  const [rootKey] = keys;
  const schemaProperties = getSchemaProperties(schema);
  return !schemaProperties || Object.hasOwn(schemaProperties, rootKey)
    ? args
    : (args[rootKey] as Record<string, unknown>);
}
