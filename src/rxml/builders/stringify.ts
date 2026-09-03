/**
 * XML stringification based on TXML's stringify approach
 * Replaces the fast-xml-parser XMLBuilder with a native implementation
 */

import type { StringifyOptions } from "../core/types";
import { RXMLStringifyError } from "../errors/types";
import {
  escapeXml,
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
} from "../utils/helpers";
import {
  stringifyNodes as stringifyNodesValue,
  stringifyNode as stringifyNodeValue,
  toContentString as toContentStringValue,
} from "./stringify-nodes";

/**
 * Stringify an object to XML
 */
export function stringify(
  rootTag: string,
  obj: RxmlValue,
  options: StringifyOptions = {}
): string {
  try {
    const format = options.format ?? true;
    const declaration = options.declaration ?? false;
    const minimalEscaping = options.minimalEscaping ?? false;
    const suppressEmptyNode = options.suppressEmptyNode ?? false;
    const strictBooleanAttributes = options.strictBooleanAttributes ?? false;

    let result = "";

    if (declaration) {
      result += '<?xml version="1.0" encoding="UTF-8"?>\n';
    }

    result += stringifyValue(rootTag, obj, {
      depth: 0,
      format,
      suppressEmptyNode,
      minimalEscaping,
      strictBooleanAttributes,
    });

    if (result.endsWith("\n")) {
      return result.slice(0, -1);
    }

    return result;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLStringifyError("Failed to stringify XML", error);
  }
}

export type RxmlValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly RxmlValue[]
  | RxmlRecord;

interface RxmlRecord {
  readonly [key: string]: RxmlValue;
}

type StringifyRecord = Record<string, RxmlValue>;

interface StringifyContext {
  depth: number;
  format: boolean;
  minimalEscaping: boolean;
  strictBooleanAttributes: boolean;
  suppressEmptyNode: boolean;
}

/**
 * Escape content based on escaping mode
 */
function escapeContent(content: string, minimalEscaping: boolean): string {
  return minimalEscaping ? escapeXmlMinimalText(content) : escapeXml(content);
}

/**
 * Create self-closing tag
 */
function createSelfClosingTag(
  tagName: string,
  indent: string,
  newline: string
): string {
  return `${indent}<${tagName}/>${newline}`;
}

/**
 * Create element with text content
 */
function createTextElement(
  tagName: string,
  content: string,
  indent: string,
  newline: string
): string {
  return `${indent}<${tagName}>${content}</${tagName}>${newline}`;
}

function isRxmlRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FormatOptions {
  indent: string;
  newline: string;
}

/**
 * Stringify a primitive value
 */
function stringifyPrimitive(
  tagName: string,
  value: string | number | boolean,
  context: StringifyContext,
  format: FormatOptions
): string {
  const { minimalEscaping, suppressEmptyNode } = context;
  const content = escapeContent(String(value), minimalEscaping);

  if (content === "" && suppressEmptyNode) {
    return "";
  }

  return createTextElement(tagName, content, format.indent, format.newline);
}

/**
 * Stringify an array value
 */
function stringifyArray(
  tagName: string,
  value: readonly RxmlValue[],
  context: StringifyContext
): string {
  let result = "";
  for (const item of value) {
    result += stringifyValue(tagName, item, context);
  }
  return result;
}

/**
 * Stringify a value to XML format
 */
function stringifyValue(
  tagName: string,
  value: RxmlValue,
  context: StringifyContext
): string {
  const { format, suppressEmptyNode, minimalEscaping } = context;
  const indent = format ? "  ".repeat(context.depth) : "";
  const newline = format ? "\n" : "";

  if (value === null || value === undefined) {
    if (suppressEmptyNode) {
      return "";
    }
    return createSelfClosingTag(tagName, indent, newline);
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return stringifyPrimitive(tagName, value, context, { indent, newline });
  }

  if (Array.isArray(value)) {
    return stringifyArray(tagName, value, context);
  }

  if (isRxmlRecord(value)) {
    return stringifyObject(tagName, value, context);
  }

  // Fallback for other types
  const content = escapeContent(String(value), minimalEscaping);
  if (content === "" && suppressEmptyNode) {
    return "";
  }
  return createTextElement(tagName, content, indent, newline);
}

interface ObjectParts {
  attributes: StringifyRecord;
  elements: StringifyRecord;
  textContent: string | undefined;
}

/**
 * Extract attributes, elements, and text content from an object
 */
function extractObjectParts(obj: RxmlRecord): ObjectParts {
  const attributes: StringifyRecord = {};
  const elements: StringifyRecord = {};
  let textContent: string | undefined;

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("@")) {
      attributes[key.slice(1)] = value;
    } else if (key === "#text" || key === "_text") {
      textContent = String(value);
    } else if (key === "_attributes") {
      if (typeof value === "object" && value !== null) {
        Object.assign(attributes, value);
      }
    } else {
      elements[key] = value;
    }
  }

  return { attributes, elements, textContent };
}

/**
 * Format a single attribute
 */
function formatAttribute(
  attrName: string,
  attrValue: RxmlValue,
  minimalEscaping: boolean,
  strictBooleanAttributes: boolean
): string {
  if (attrValue === null) {
    return strictBooleanAttributes
      ? ` ${attrName}="${attrName}"`
      : ` ${attrName}`;
  }

  const valueStr = String(attrValue);
  // Attribute quoting strategy per XML 1.0:
  // - 3.1 (AttValue [10]): attribute values MUST be quoted with ' or ".
  //   If the same quote appears in the value, it MUST be escaped (via
  //   predefined entities per 4.6). We choose the quote that minimizes
  //   escaping: prefer " unless value contains ", otherwise use '.
  //   See: https://www.w3.org/TR/2008/REC-xml-20081126/
  if (valueStr.indexOf('"') === -1) {
    const escaped = minimalEscaping
      ? escapeXmlMinimalAttr(valueStr, '"')
      : escapeXml(valueStr);
    return ` ${attrName}="${escaped}"`;
  }

  const escaped = minimalEscaping
    ? escapeXmlMinimalAttr(valueStr, "'")
    : escapeXml(valueStr);
  return ` ${attrName}='${escaped}'`;
}

/**
 * Build opening tag with attributes
 */
function buildOpeningTag(
  tagName: string,
  attributes: StringifyRecord,
  context: StringifyContext
): string {
  let openTag = `<${tagName}`;
  const { minimalEscaping, strictBooleanAttributes } = context;

  for (const [attrName, attrValue] of Object.entries(attributes)) {
    openTag += formatAttribute(
      attrName,
      attrValue,
      minimalEscaping,
      strictBooleanAttributes
    );
  }

  return openTag;
}

/**
 * Stringify text-only content
 */
function stringifyTextOnlyContent(options: {
  tagName: string;
  textContent: string;
  openTag: string;
  format: FormatOptions;
  minimalEscaping: boolean;
}): string {
  const { tagName, textContent, openTag, format, minimalEscaping } = options;
  const content = escapeContent(textContent, minimalEscaping);
  return `${format.indent}${openTag}${content}</${tagName}>${format.newline}`;
}

interface ComplexContentOptions {
  childIndent: string;
  indent: string;
  newline: string;
  openTag: string;
}

/**
 * Stringify complex content (text + elements)
 */
function stringifyComplexContent(
  tagName: string,
  parts: ObjectParts,
  context: StringifyContext,
  options: ComplexContentOptions
): string {
  const { format, minimalEscaping, depth } = context;
  const { textContent, elements } = parts;
  const hasElements = Object.keys(elements).length > 0;

  let result = `${options.indent}${options.openTag}`;

  if (textContent) {
    const content = escapeContent(textContent, minimalEscaping);
    result += format
      ? `${options.newline}${options.childIndent}${content}`
      : content;
  }

  if (hasElements) {
    if (format) {
      result += options.newline;
    }

    for (const [elementName, elementValue] of Object.entries(elements)) {
      result += stringifyValue(elementName, elementValue, {
        ...context,
        depth: depth + 1,
      });
    }

    if (format) {
      result += options.indent;
    }
  }

  result += `</${tagName}>${options.newline}`;
  return result;
}

/**
 * Stringify an object to XML
 */
function stringifyObject(
  tagName: string,
  obj: RxmlRecord,
  context: StringifyContext
): string {
  const { depth, format, suppressEmptyNode } = context;
  const indent = format ? "  ".repeat(depth) : "";
  const newline = format ? "\n" : "";
  const childIndent = format ? "  ".repeat(depth + 1) : "";

  const parts = extractObjectParts(obj);
  const openTag = buildOpeningTag(tagName, parts.attributes, context);

  // Check if we have any content
  const hasElements = Object.keys(parts.elements).length > 0;
  const hasTextContent =
    parts.textContent !== undefined && parts.textContent !== "";

  if (!(hasElements || hasTextContent)) {
    if (suppressEmptyNode) {
      return "";
    }
    return `${indent}${openTag}/>${newline}`;
  }

  const fullOpenTag = `${openTag}>`;

  // Handle text-only content
  if (!hasElements && hasTextContent && parts.textContent) {
    return stringifyTextOnlyContent({
      tagName,
      textContent: parts.textContent,
      openTag: fullOpenTag,
      format: { indent, newline },
      minimalEscaping: context.minimalEscaping,
    });
  }

  // Handle complex content
  return stringifyComplexContent(tagName, parts, context, {
    indent,
    newline,
    childIndent,
    openTag: fullOpenTag,
  });
}

export const stringifyNode = stringifyNodeValue;
export const stringifyNodes = stringifyNodesValue;
export const toContentString = toContentStringValue;
