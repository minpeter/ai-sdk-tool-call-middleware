/**
 * XML stringification based on TXML's stringify approach
 * Replaces the fast-xml-parser XMLBuilder with a native implementation
 */

import type { RXMLNode, StringifyOptions } from "../core/types";
import { RXMLStringifyError } from "../errors/types";
import { escapeXml } from "../utils/helpers";

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
    const suppressEmptyNode = options.suppressEmptyNode ?? false;

    let result = "";

    if (format) {
      result += '<?xml version="1.0" encoding="UTF-8"?>\n';
    }

    result += stringifyValue(rootTag, obj, 0, format, suppressEmptyNode);

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
  suppressEmptyNode: boolean
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
    const content = escapeXml(String(value));
    if (content === "" && suppressEmptyNode) return "";
    return `${indent}<${tagName}>${content}</${tagName}>${newline}`;
  }

  if (Array.isArray(value)) {
    let result = "";
    for (const item of value) {
      result += stringifyValue(tagName, item, depth, format, suppressEmptyNode);
    }
    return result;
  }

  if (typeof value === "object") {
    return stringifyObject(
      tagName,
      value as Record<string, unknown>,
      depth,
      format,
      suppressEmptyNode
    );
  }

  // Fallback for other types
  const content = escapeXml(String(value));
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
  suppressEmptyNode: boolean
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
      openTag += ` ${attrName}`;
    } else {
      const valueStr = String(attrValue);
      const hasDoubleQuotes = valueStr.indexOf('"') !== -1;
      const hasSpecialChars = /[&<>]/.test(valueStr);

      if (hasDoubleQuotes && !hasSpecialChars) {
        // Use single quotes and don't escape quotes when only quotes are present
        openTag += ` ${attrName}='${valueStr}'`;
      } else {
        // Use double quotes and escape everything including quotes
        const escaped = valueStr
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        openTag += ` ${attrName}="${escaped}"`;
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
    return `${indent}${openTag}${escapeXml(textContent)}</${tagName}>${newline}`;
  }

  // Handle complex content
  let result = `${indent}${openTag}`;

  if (hasTextContent && textContent) {
    if (format) result += `${newline}${childIndent}${escapeXml(textContent)}`;
    else result += escapeXml(textContent);
  }

  if (hasElements) {
    if (format) result += newline;

    for (const [elementName, elementValue] of Object.entries(elements)) {
      result += stringifyValue(
        elementName,
        elementValue,
        depth + 1,
        format,
        suppressEmptyNode
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
  format = true
): string {
  let result = "";

  for (const node of nodes) {
    if (typeof node === "string") {
      result += node;
    } else {
      result += stringifyNode(node, 0, format);
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
  format = true
): string {
  const indent = format ? "  ".repeat(depth) : "";
  const newline = format ? "\n" : "";

  let result = `${indent}<${node.tagName}`;

  // Add attributes
  for (const [attrName, attrValue] of Object.entries(node.attributes)) {
    if (attrValue === null) {
      result += ` ${attrName}`;
    } else if (attrValue.indexOf('"') === -1) {
      result += ` ${attrName}="${escapeXml(attrValue)}"`;
    } else {
      result += ` ${attrName}='${escapeXml(attrValue)}'`;
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
      result += escapeXml(child);
    } else {
      if (!hasElementChildren && format) {
        result += newline;
        hasElementChildren = true;
      }
      result += stringifyNode(child, depth + 1, format);
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
