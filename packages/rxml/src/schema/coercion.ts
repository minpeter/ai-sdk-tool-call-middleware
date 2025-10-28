/**
 * Schema-aware type coercion for robust-xml
 * Integrates with the existing coercion system but adds XML-specific handling
 */

import type { RXMLNode } from "../core/types";
import { RXMLCoercionError } from "../errors/types";
import {
  coerceBySchema as baseCoerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "./base-coercion";

/**
 * Get property schema from a parent schema
 */
export function getPropertySchema(toolSchema: unknown, key: string): unknown {
  const unwrapped = unwrapJsonSchema(toolSchema);
  if (!unwrapped || typeof unwrapped !== "object") {
    return;
  }
  const u = unwrapped as Record<string, unknown>;
  const props = u.properties as Record<string, unknown> | undefined;
  if (props && Object.prototype.hasOwnProperty.call(props, key)) {
    return (props as Record<string, unknown>)[key];
  }
  return;
}

/**
 * Get node value from children
 */
function getNodeValue(
  children: (RXMLNode | string)[],
  schema: unknown,
  tagName: string,
  textNodeName: string
): unknown {
  if (children.length === 0) {
    return "";
  }
  if (children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }
  return processComplexContent(
    children,
    getPropertySchema(schema, tagName),
    textNodeName
  );
}

/**
 * Add attributes to value
 */
function addAttributesToValue(
  value: unknown,
  attributes: Record<string, string>,
  textNodeName: string
): unknown {
  if (Object.keys(attributes).length === 0) {
    return value;
  }

  if (typeof value === "string") {
    const valueResult: Record<string, unknown> = { [textNodeName]: value };
    for (const [attrName, attrValue] of Object.entries(attributes)) {
      valueResult[`@_${attrName}`] = attrValue;
    }
    return valueResult;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [attrName, attrValue] of Object.entries(attributes)) {
      (value as Record<string, unknown>)[`@_${attrName}`] = attrValue;
    }
  }

  return value;
}

/**
 * Add value to result, handling duplicates
 */
function addToResult(
  result: Record<string, unknown>,
  tagName: string,
  value: unknown
): void {
  if (result[tagName]) {
    if (!Array.isArray(result[tagName])) {
      result[tagName] = [result[tagName]];
    }
    (result[tagName] as unknown[]).push(value);
  } else {
    result[tagName] = value;
  }
}

/**
 * Convert TXML-style DOM to flat object structure for schema coercion
 */
export function domToObject(
  nodes: (RXMLNode | string)[],
  schema: unknown,
  textNodeName = "#text"
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const node of nodes) {
    if (typeof node === "string") {
      continue;
    }

    const { tagName, children, attributes } = node;
    let value = getNodeValue(children, schema, tagName, textNodeName);
    value = addAttributesToValue(value, attributes, textNodeName);
    addToResult(result, tagName, value);
  }

  return result;
}

/**
 * Process child element node
 */
function processChildElement(
  child: RXMLNode,
  schema: unknown,
  textNodeName: string
): unknown {
  let childValue: unknown;

  if (child.children.length === 0) {
    childValue = "";
  } else if (
    child.children.length === 1 &&
    typeof child.children[0] === "string"
  ) {
    childValue = child.children[0];
  } else {
    childValue = processComplexContent(
      child.children,
      getPropertySchema(schema, child.tagName),
      textNodeName
    );
  }

  return addAttributesToValue(childValue, child.attributes, textNodeName);
}

/**
 * Combine text and elements into result
 */
function combineContent(
  textContent: string[],
  elements: Record<string, unknown>,
  textNodeName: string
): unknown {
  const hasText = textContent.length > 0;
  const hasElements = Object.keys(elements).length > 0;

  if (hasText && hasElements) {
    return {
      [textNodeName]: textContent.join("").trim(),
      ...elements,
    };
  }

  if (hasText) {
    return textContent.join("").trim();
  }

  if (hasElements) {
    return elements;
  }

  return "";
}

/**
 * Process complex content (mixed text and elements)
 */
function processComplexContent(
  children: (RXMLNode | string)[],
  schema: unknown,
  textNodeName: string
): unknown {
  const textContent: string[] = [];
  const elements: Record<string, unknown> = {};

  for (const child of children) {
    if (typeof child === "string") {
      textContent.push(child);
    } else {
      const childValue = processChildElement(child, schema, textNodeName);
      addToResult(elements, child.tagName, childValue);
    }
  }

  return combineContent(textContent, elements, textNodeName);
}

/**
 * Coerce DOM object using schema information
 */
export function coerceDomBySchema(
  domObject: Record<string, unknown>,
  schema: unknown
): Record<string, unknown> {
  try {
    return baseCoerceBySchema(domObject, schema) as Record<string, unknown>;
  } catch (error) {
    throw new RXMLCoercionError("Failed to coerce DOM object by schema", error);
  }
}

/**
 * Visit object schema properties
 */
function visitObjectProperties(
  props: Record<string, unknown>,
  collected: Set<string>,
  visit: (s: unknown) => void
): void {
  for (const [key, propSchema] of Object.entries(props)) {
    const t = getSchemaType(propSchema);
    if (t === "string") {
      collected.add(key);
    } else if (t === "object" || t === "array") {
      visit(propSchema);
    }
  }
}

/**
 * Visit array schema items
 */
function visitArrayItems(
  u: Record<string, unknown>,
  visit: (s: unknown) => void
): void {
  const items = u.items as unknown;
  if (items) {
    visit(items);
  }
  const prefix = u.prefixItems as unknown[] | undefined;
  if (Array.isArray(prefix)) {
    for (const item of prefix) {
      visit(item);
    }
  }
}

/**
 * Extract string-typed property names from schema
 */
export function getStringTypedProperties(schema: unknown): Set<string> {
  const collected = new Set<string>();

  const visit = (s: unknown): void => {
    const unwrapped = unwrapJsonSchema(s);
    if (!unwrapped || typeof unwrapped !== "object") {
      return;
    }
    const u = unwrapped as Record<string, unknown>;
    const type = getSchemaType(unwrapped);

    if (type === "object") {
      const props = u.properties as Record<string, unknown> | undefined;
      if (props && typeof props === "object") {
        visitObjectProperties(props, collected, visit);
      }
    } else if (type === "array") {
      visitArrayItems(u, visit);
    }
  };

  visit(schema);
  return collected;
}

/**
 * Process array-like structures from XML
 */
export function processArrayContent(
  value: unknown,
  schema: unknown,
  textNodeName: string
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  const schemaType = getSchemaType(schema);

  if (schemaType === "string") {
    // For string arrays, extract text content and take first item for duplicates
    return value.map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (item && typeof item === "object" && textNodeName in item) {
        const textVal = (item as Record<string, unknown>)[textNodeName];
        return typeof textVal === "string" ? textVal.trim() : String(textVal);
      }
      return String(item);
    });
  }

  // For other types, process each item
  return value.map((item) => {
    if (typeof item === "string") {
      return item.trim();
    }
    if (item && typeof item === "object" && textNodeName in item) {
      const textVal = (item as Record<string, unknown>)[textNodeName];
      return typeof textVal === "string" ? textVal.trim() : textVal;
    }
    return item;
  });
}

/**
 * Handle indexed tuple structures (elements with numeric keys)
 */
export function processIndexedTuple(
  obj: Record<string, unknown>,
  textNodeName: string
): unknown[] {
  const keys = Object.keys(obj);
  const indices = keys.map((k) => Number.parseInt(k, 10)).sort((a, b) => a - b);
  const isValidTuple =
    indices[0] === 0 && indices.every((val, idx) => val === idx);

  if (!isValidTuple) {
    return [obj];
  }

  const sortedKeys = keys.sort(
    (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)
  );
  return sortedKeys.map((key) => {
    const item = obj[key];
    if (item && typeof item === "object" && textNodeName in item) {
      const textVal = (item as Record<string, unknown>)[textNodeName];
      return typeof textVal === "string" ? textVal.trim() : textVal;
    }
    return typeof item === "string" ? item.trim() : item;
  });
}
