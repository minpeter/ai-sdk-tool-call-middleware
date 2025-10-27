/**
 * XML stringification based on TXML's stringify approach
 * Replaces the fast-xml-parser XMLBuilder with a native implementation
 */

import type { RXMLNode, StringifyOptions } from "../core/types";
import { RXMLStringifyError } from "../errors/types";
import {
  escapeXml,
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
} from "../utils/helpers";

/**
 * Stringify an object to XML
 */
export function stringify(
  rootTag: string,
  obj: unknown,
  options: StringifyOptions = {}
): string {
  try {
    const format = options.format ?? true;
    const minimalEscaping = options.minimalEscaping ?? false;
    const suppressEmptyNode = options.suppressEmptyNode ?? false;
    const strictBooleanAttributes = options.strictBooleanAttributes ?? false;

    let result = "";

    if (format) {
      result += '<?xml version="1.0" encoding="UTF-8"?>\n';
    }

    result += stringifyValue(rootTag, obj, {
      depth: 0,
      format,
      suppressEmptyNode,
      minimalEscaping,
      strictBooleanAttributes,
    });

    return result;
  } catch (error) {
    throw new RXMLStringifyError("Failed to stringify XML", error);
  }
}

interface StringifyContext {
  depth: number;
  format: boolean;
  suppressEmptyNode: boolean;
  minimalEscaping: boolean;
  strictBooleanAttributes: boolean;
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

/**
 * Check if value is a primitive type
 */
function isPrimitive(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Stringify a primitive value
 */
function stringifyPrimitive(
  tagName: string,
  value: unknown,
  context: StringifyContext,
  indent: string,
  newline: string
): string {
  const { minimalEscaping, suppressEmptyNode } = context;
  const content = escapeContent(String(value), minimalEscaping);

  if (content === "" && suppressEmptyNode) {
    return "";
  }

  return createTextElement(tagName, content, indent, newline);
}

/**
 * Stringify an array value
 */
function stringifyArray(
  tagName: string,
  value: unknown[],
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
  value: unknown,
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

  if (isPrimitive(value)) {
    return stringifyPrimitive(tagName, value, context, indent, newline);
  }

  if (Array.isArray(value)) {
    return stringifyArray(tagName, value, context);
  }

  if (typeof value === "object") {
    return stringifyObject(tagName, value as Record<string, unknown>, context);
  }

  // Fallback for other types
  const content = escapeContent(String(value), minimalEscaping);
  if (content === "" && suppressEmptyNode) {
    return "";
  }
  return createTextElement(tagName, content, indent, newline);
}

interface ObjectParts {
  attributes: Record<string, unknown>;
  elements: Record<string, unknown>;
  textContent: string | undefined;
}

/**
 * Extract attributes, elements, and text content from an object
 */
function extractObjectParts(obj: Record<string, unknown>): ObjectParts {
  const attributes: Record<string, unknown> = {};
  const elements: Record<string, unknown> = {};
  let textContent: string | undefined;

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("@")) {
      attributes[key.substring(1)] = value;
    } else if (key === "#text" || key === "_text") {
      textContent = String(value);
    } else if (key === "_attributes") {
      if (typeof value === "object" && value !== null) {
        Object.assign(attributes, value as Record<string, unknown>);
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
  attrValue: unknown,
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
  attributes: Record<string, unknown>,
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
function stringifyTextOnlyContent(
  tagName: string,
  textContent: string,
  indent: string,
  newline: string,
  openTag: string,
  minimalEscaping: boolean
): string {
  const content = escapeContent(textContent, minimalEscaping);
  return `${indent}${openTag}${content}</${tagName}>${newline}`;
}

/**
 * Stringify complex content (text + elements)
 */
function stringifyComplexContent(
  tagName: string,
  parts: ObjectParts,
  context: StringifyContext,
  indent: string,
  newline: string,
  childIndent: string,
  openTag: string
): string {
  const { format, minimalEscaping, depth } = context;
  const { textContent, elements } = parts;
  const hasElements = Object.keys(elements).length > 0;

  let result = `${indent}${openTag}`;

  if (textContent) {
    const content = escapeContent(textContent, minimalEscaping);
    result += format ? `${newline}${childIndent}${content}` : content;
  }

  if (hasElements) {
    if (format) {
      result += newline;
    }

    for (const [elementName, elementValue] of Object.entries(elements)) {
      result += stringifyValue(elementName, elementValue, {
        ...context,
        depth: depth + 1,
      });
    }

    if (format) {
      result += indent;
    }
  }

  result += `</${tagName}>${newline}`;
  return result;
}

/**
 * Stringify an object to XML
 */
function stringifyObject(
  tagName: string,
  obj: Record<string, unknown>,
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
    return stringifyTextOnlyContent(
      tagName,
      parts.textContent,
      indent,
      newline,
      fullOpenTag,
      context.minimalEscaping
    );
  }

  // Handle complex content
  return stringifyComplexContent(
    tagName,
    parts,
    context,
    indent,
    newline,
    childIndent,
    fullOpenTag
  );
}

/**
 * Stringify parsed XML nodes back to XML string
 */
export function stringifyNodes(
  nodes: (RXMLNode | string)[],
  format = true,
  options: Pick<
    StringifyOptions,
    "strictBooleanAttributes" | "minimalEscaping"
  > = {}
): string {
  let result = "";

  for (const node of nodes) {
    if (typeof node === "string") {
      result += node;
    } else {
      result += stringifyNode(node, 0, format, options);
    }
  }

  return result;
}

/**
 * Stringify a single XML node
 */
export function stringifyNode(
  node: RXMLNode,
  depth = 0,
  format = true,
  options: Pick<
    StringifyOptions,
    "strictBooleanAttributes" | "minimalEscaping"
  > = {}
): string {
  const indent = format ? "  ".repeat(depth) : "";
  const newline = format ? "\n" : "";
  const minimalEscaping = options.minimalEscaping ?? false;
  const strictBooleanAttributes = options.strictBooleanAttributes ?? false;

  let result = `${indent}<${node.tagName}`;

  // Add attributes
  for (const [attrName, attrValue] of Object.entries(node.attributes)) {
    if (attrValue === null) {
      if (strictBooleanAttributes) {
        result += ` ${attrName}="${attrName}"`;
      } else {
        result += ` ${attrName}`;
      }
    } else if (attrValue.indexOf('"') === -1) {
      const escaped = minimalEscaping
        ? escapeXmlMinimalAttr(attrValue, '"')
        : escapeXml(attrValue);
      result += ` ${attrName}="${escaped}"`;
    } else {
      const escaped = minimalEscaping
        ? escapeXmlMinimalAttr(attrValue, "'")
        : escapeXml(attrValue);
      result += ` ${attrName}='${escaped}'`;
    }
  }

  // Handle processing instructions
  if (node.tagName[0] === "?") {
    result += "?>";
    return result + newline;
  }

  // Handle self-closing tags
  if (node.children.length === 0) {
    result += "/>";
    return result + newline;
  }

  result += ">";

  // Handle children
  let hasElementChildren = false;
  for (const child of node.children) {
    if (typeof child === "string") {
      result += minimalEscaping
        ? escapeXmlMinimalText(child)
        : escapeXml(child);
    } else {
      if (!hasElementChildren && format) {
        result += newline;
        hasElementChildren = true;
      }
      result += stringifyNode(child, depth + 1, format, options);
    }
  }

  if (hasElementChildren && format) {
    result += indent;
  }

  result += `</${node.tagName}>`;

  if (format) {
    result += newline;
  }

  return result;
}

/**
 * Convert content to a string representation (similar to TXML's toContentString)
 */
export function toContentString(nodes: (RXMLNode | string)[]): string {
  let result = "";

  for (const node of nodes) {
    if (typeof node === "string") {
      result += " " + node;
    } else {
      result += " " + toContentString(node.children);
    }
    result = result.trim();
  }

  return result;
}
