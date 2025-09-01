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

    result += stringifyValue(
      rootTag,
      obj,
      0,
      format,
      suppressEmptyNode,
      minimalEscaping,
      strictBooleanAttributes
    );

    return result;
  } catch (error) {
    throw new RXMLStringifyError("Failed to stringify XML", error);
  }
}

/**
 * Stringify a value to XML format
 */
function stringifyValue(
  tagName: string,
  value: unknown,
  depth: number,
  format: boolean,
  suppressEmptyNode: boolean,
  minimalEscaping: boolean,
  strictBooleanAttributes: boolean
): string {
  const indent = format ? "  ".repeat(depth) : "";
  const newline = format ? "\n" : "";

  if (value === null || value === undefined) {
    if (suppressEmptyNode) return "";
    return `${indent}<${tagName}/>${newline}`;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const content = minimalEscaping
      ? escapeXmlMinimalText(String(value))
      : escapeXml(String(value));
    if (content === "" && suppressEmptyNode) return "";
    return `${indent}<${tagName}>${content}</${tagName}>${newline}`;
  }

  if (Array.isArray(value)) {
    let result = "";
    for (const item of value) {
      result += stringifyValue(
        tagName,
        item,
        depth,
        format,
        suppressEmptyNode,
        minimalEscaping,
        strictBooleanAttributes
      );
    }
    return result;
  }

  if (typeof value === "object") {
    return stringifyObject(
      tagName,
      value as Record<string, unknown>,
      depth,
      format,
      suppressEmptyNode,
      minimalEscaping,
      strictBooleanAttributes
    );
  }

  // Fallback for other types
  const content = minimalEscaping
    ? escapeXmlMinimalText(String(value))
    : escapeXml(String(value));
  if (content === "" && suppressEmptyNode) return "";
  return `${indent}<${tagName}>${content}</${tagName}>${newline}`;
}

/**
 * Stringify an object to XML
 */
function stringifyObject(
  tagName: string,
  obj: Record<string, unknown>,
  depth: number,
  format: boolean,
  suppressEmptyNode: boolean,
  minimalEscaping: boolean,
  strictBooleanAttributes: boolean
): string {
  const indent = format ? "  ".repeat(depth) : "";
  const newline = format ? "\n" : "";
  const childIndent = format ? "  ".repeat(depth + 1) : "";

  // Extract attributes (properties starting with @)
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

  // Build opening tag with attributes
  let openTag = `<${tagName}`;
  for (const [attrName, attrValue] of Object.entries(attributes)) {
    if (attrValue === null) {
      if (strictBooleanAttributes) {
        openTag += ` ${attrName}="${attrName}"`;
      } else {
        openTag += ` ${attrName}`;
      }
    } else {
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
        openTag += ` ${attrName}="${escaped}"`;
      } else {
        const escaped = minimalEscaping
          ? escapeXmlMinimalAttr(valueStr, "'")
          : escapeXml(valueStr);
        openTag += ` ${attrName}='${escaped}'`;
      }
    }
  }

  // Check if we have any content
  const hasElements = Object.keys(elements).length > 0;
  const hasTextContent = textContent !== undefined && textContent !== "";

  if (!hasElements && !hasTextContent) {
    if (suppressEmptyNode) return "";
    return `${indent}${openTag}/>${newline}`;
  }

  openTag += ">";

  // Handle text-only content
  if (!hasElements && hasTextContent && textContent) {
    // 2.4 Character Data and Markup: '<' and '&' MUST be escaped in content.
    // Minimal vs conservative controlled by option.
    const content = minimalEscaping
      ? escapeXmlMinimalText(textContent)
      : escapeXml(textContent);
    return `${indent}${openTag}${content}</${tagName}>${newline}`;
  }

  // Handle complex content
  let result = `${indent}${openTag}`;

  if (hasTextContent && textContent) {
    // See spec notes above (2.4, 4.6) for escaping rationale.
    const content = minimalEscaping
      ? escapeXmlMinimalText(textContent)
      : escapeXml(textContent);
    if (format) result += `${newline}${childIndent}${content}`;
    else result += content;
  }

  if (hasElements) {
    if (format) result += newline;

    for (const [elementName, elementValue] of Object.entries(elements)) {
      result += stringifyValue(
        elementName,
        elementValue,
        depth + 1,
        format,
        suppressEmptyNode,
        minimalEscaping,
        strictBooleanAttributes
      );
    }

    if (format) result += indent;
  }

  result += `</${tagName}>${newline}`;

  return result;
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
