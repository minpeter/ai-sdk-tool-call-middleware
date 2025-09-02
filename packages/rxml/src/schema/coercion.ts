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
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const u = unwrapped as Record<string, unknown>;
  const props = u.properties as Record<string, unknown> | undefined;
  if (props && Object.prototype.hasOwnProperty.call(props, key)) {
    return (props as Record<string, unknown>)[key];
  }
  return undefined;
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
      // Top-level text content - usually from DOCTYPE, comments, etc.
      continue;
    }

    const { tagName, children, attributes } = node;

    // Handle the node content
    let value: unknown;

    if (children.length === 0) {
      // Empty element
      value = "";
    } else if (children.length === 1 && typeof children[0] === "string") {
      // Simple text content
      value = children[0];
    } else {
      // Complex content - convert children to object/array
      value = processComplexContent(
        children,
        getPropertySchema(schema, tagName),
        textNodeName
      );
    }

    // Add attributes if present
    if (Object.keys(attributes).length > 0) {
      if (typeof value === "string") {
        // For string values with attributes, create an object with text content and prefixed attributes
        const result: Record<string, unknown> = { [textNodeName]: value };
        for (const [attrName, attrValue] of Object.entries(attributes)) {
          result[`@_${attrName}`] = attrValue;
        }
        value = result;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        // For object values, add attributes with @_ prefix
        for (const [attrName, attrValue] of Object.entries(attributes)) {
          (value as Record<string, unknown>)[`@_${attrName}`] = attrValue;
        }
      }
    }

    // Handle multiple elements with same tag name
    if (result[tagName]) {
      if (!Array.isArray(result[tagName])) {
        result[tagName] = [result[tagName]];
      }
      (result[tagName] as unknown[]).push(value);
    } else {
      result[tagName] = value;
    }
  }

  return result;
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
      // Process the entire child node, not just its children
      let childValue: unknown;

      if (child.children.length === 0) {
        // Empty element
        childValue = "";
      } else if (
        child.children.length === 1 &&
        typeof child.children[0] === "string"
      ) {
        // Simple text content
        childValue = child.children[0];
      } else {
        // Complex content - convert children to object/array
        childValue = processComplexContent(
          child.children,
          getPropertySchema(schema, child.tagName),
          textNodeName
        );
      }

      // Add attributes if present
      if (Object.keys(child.attributes).length > 0) {
        if (typeof childValue === "string") {
          // For string values with attributes, create an object with text content and prefixed attributes
          const result: Record<string, unknown> = {
            [textNodeName]: childValue,
          };
          for (const [attrName, attrValue] of Object.entries(
            child.attributes
          )) {
            result[`@_${attrName}`] = attrValue;
          }
          childValue = result;
        } else if (
          childValue &&
          typeof childValue === "object" &&
          !Array.isArray(childValue)
        ) {
          // For object values, add attributes with @_ prefix
          for (const [attrName, attrValue] of Object.entries(
            child.attributes
          )) {
            (childValue as Record<string, unknown>)[`@_${attrName}`] =
              attrValue;
          }
        }
      }

      if (elements[child.tagName]) {
        if (!Array.isArray(elements[child.tagName])) {
          elements[child.tagName] = [elements[child.tagName]];
        }
        (elements[child.tagName] as unknown[]).push(childValue);
      } else {
        elements[child.tagName] = childValue;
      }
    }
  }

  // If we have both text and elements, create a mixed content object
  if (textContent.length > 0 && Object.keys(elements).length > 0) {
    return {
      [textNodeName]: textContent.join("").trim(),
      ...elements,
    };
  }

  // If only text content
  if (textContent.length > 0 && Object.keys(elements).length === 0) {
    return textContent.join("").trim();
  }

  // If only elements
  if (Object.keys(elements).length > 0) {
    return elements;
  }

  // Empty content
  return "";
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
 * Extract string-typed property names from schema
 */
export function getStringTypedProperties(schema: unknown): Set<string> {
  const collected = new Set<string>();

  const visit = (s: unknown): void => {
    const unwrapped = unwrapJsonSchema(s);
    if (!unwrapped || typeof unwrapped !== "object") return;
    const u = unwrapped as Record<string, unknown>;
    const type = getSchemaType(unwrapped);

    if (type === "object") {
      const props = u.properties as Record<string, unknown> | undefined;
      if (props && typeof props === "object") {
        for (const [key, propSchema] of Object.entries(props)) {
          const t = getSchemaType(propSchema);
          if (t === "string") {
            collected.add(key);
          } else if (t === "object" || t === "array") {
            visit(propSchema);
          }
        }
      }
    } else if (type === "array") {
      const items = (u as Record<string, unknown>).items as unknown;
      if (items) visit(items);
      const prefix = (u as Record<string, unknown>).prefixItems as
        | unknown[]
        | undefined;
      if (Array.isArray(prefix)) prefix.forEach(visit);
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
  if (!Array.isArray(value)) return value;

  const schemaType = getSchemaType(schema);

  if (schemaType === "string") {
    // For string arrays, extract text content and take first item for duplicates
    return value.map(item => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && textNodeName in item) {
        const textVal = (item as Record<string, unknown>)[textNodeName];
        return typeof textVal === "string" ? textVal.trim() : String(textVal);
      }
      return String(item);
    });
  }

  // For other types, process each item
  return value.map(item => {
    if (typeof item === "string") return item.trim();
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
  const indices = keys.map(k => parseInt(k, 10)).sort((a, b) => a - b);
  const isValidTuple =
    indices[0] === 0 && indices.every((val, idx) => val === idx);

  if (!isValidTuple) return [obj];

  const sortedKeys = keys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return sortedKeys.map(key => {
    const item = obj[key];
    if (item && typeof item === "object" && textNodeName in item) {
      const textVal = (item as Record<string, unknown>)[textNodeName];
      return typeof textVal === "string" ? textVal.trim() : textVal;
    }
    return typeof item === "string" ? item.trim() : item;
  });
}
