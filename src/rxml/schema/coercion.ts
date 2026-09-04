import { isJSONObject, type JSONObject } from "@ai-sdk/provider";
import type {
  ToolInputSchema,
  ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import {
  coerceBySchema as baseCoerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "../../schema-coerce";
import type { RxmlValue } from "../builders/stringify";
import type { RXMLNode } from "../core/types";
import { RXMLCoercionError } from "../errors/types";

const PROTOTYPE_SENSITIVE_XML_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type ParsedSchema = ToolInputSchemaDefinition | undefined;
type RxmlRecord = Record<string, RxmlValue>;
type RxmlContent = string | RxmlRecord;

function isRxmlRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeXmlObjectKey(key: string): void {
  if (PROTOTYPE_SENSITIVE_XML_KEYS.has(key)) {
    throw new RXMLCoercionError(
      `RXML: Prototype-sensitive XML key "${key}" is not allowed.`
    );
  }
}

export function getPropertySchema(
  toolSchema: ParsedSchema,
  key: string
): ToolInputSchemaDefinition | undefined {
  const unwrapped = unwrapJsonSchema(toolSchema);
  if (!unwrapped || typeof unwrapped !== "object") {
    return;
  }
  const { properties } = unwrapped;
  return properties && Object.hasOwn(properties, key)
    ? properties[key]
    : undefined;
}

function getNodeValue(
  children: (RXMLNode | string)[],
  schema: ParsedSchema,
  tagName: string,
  textNodeName: string
): RxmlContent {
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

function addAttributesToValue(
  value: RxmlContent,
  attributes: Record<string, string | null>,
  textNodeName: string
): RxmlContent {
  if (Object.keys(attributes).length === 0) {
    return value;
  }

  if (typeof value === "string") {
    const valueResult: RxmlRecord = Object.create(null);
    valueResult[textNodeName] = value;
    for (const [attrName, attrValue] of Object.entries(attributes)) {
      valueResult[`@_${attrName}`] = attrValue;
    }
    return valueResult;
  }

  const valueResult: RxmlRecord = Object.create(null);
  for (const [key, nestedValue] of Object.entries(value)) {
    valueResult[key] = nestedValue;
  }
  for (const [attrName, attrValue] of Object.entries(attributes)) {
    valueResult[`@_${attrName}`] = attrValue;
  }
  return valueResult;
}

function addToResult(
  result: RxmlRecord,
  tagName: string,
  value: RxmlValue
): void {
  assertSafeXmlObjectKey(tagName);
  if (!Object.hasOwn(result, tagName)) {
    result[tagName] = value;
    return;
  }
  const current = result[tagName];
  result[tagName] = Array.isArray(current)
    ? [...current, value]
    : [current, value];
}

export function domToObject(
  nodes: (RXMLNode | string)[],
  schema: ParsedSchema,
  textNodeName = "#text"
): RxmlRecord {
  const result: RxmlRecord = Object.create(null);

  for (const node of nodes) {
    if (typeof node === "string") {
      continue;
    }

    const { tagName, children, attributes } = node;
    const nodeValue = getNodeValue(children, schema, tagName, textNodeName);
    const value = addAttributesToValue(nodeValue, attributes, textNodeName);
    addToResult(result, tagName, value);
  }

  return result;
}

function processChildElement(
  child: RXMLNode,
  schema: ParsedSchema,
  textNodeName: string
): RxmlContent {
  let childValue: RxmlContent;

  if (child.children.length === 0) {
    childValue = "";
  } else if (
    child.children.length === 1 &&
    typeof child.children[0] === "string"
  ) {
    [childValue] = child.children;
  } else {
    childValue = processComplexContent(
      child.children,
      getPropertySchema(schema, child.tagName),
      textNodeName
    );
  }

  return addAttributesToValue(childValue, child.attributes, textNodeName);
}

function combineContent(
  textContent: string[],
  elements: RxmlRecord,
  textNodeName: string
): RxmlContent {
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
  return elements;
}

function processComplexContent(
  children: (RXMLNode | string)[],
  schema: ParsedSchema,
  textNodeName: string
): RxmlContent {
  const textContent: string[] = [];
  const elements: RxmlRecord = Object.create(null);

  for (const child of children) {
    if (typeof child === "string") {
      textContent.push(child);
      continue;
    }
    addToResult(
      elements,
      child.tagName,
      processChildElement(child, schema, textNodeName)
    );
  }

  return combineContent(textContent, elements, textNodeName);
}

export function coerceDomBySchema(
  domObject: RxmlRecord,
  schema: ParsedSchema
): JSONObject {
  try {
    const coerced = baseCoerceBySchema(domObject, schema);
    if (!isJSONObject(coerced)) {
      throw new TypeError("RXML schema coercion returned a non-object value");
    }
    return coerced;
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    throw Object.assign(
      new RXMLCoercionError("Failed to coerce DOM object by schema"),
      { cause: normalizedError }
    );
  }
}

function collectObjectStringProperties(
  schema: ToolInputSchema,
  collected: Set<string>,
  stack: ToolInputSchemaDefinition[]
): void {
  if (getSchemaType(schema) !== "object" || !schema.properties) {
    return;
  }
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    const propertyType = getSchemaType(propertySchema);
    if (propertyType === "string") {
      collected.add(key);
    } else if (propertyType === "object" || propertyType === "array") {
      stack.push(propertySchema);
    }
  }
}

function collectArrayItemSchemas(
  schema: ToolInputSchema,
  stack: ToolInputSchemaDefinition[]
): void {
  if (getSchemaType(schema) !== "array") {
    return;
  }
  if (Array.isArray(schema.items)) {
    stack.push(...schema.items);
  } else if (schema.items) {
    stack.push(schema.items);
  }
  if (Array.isArray(schema.prefixItems)) {
    stack.push(...schema.prefixItems);
  }
}

export function getStringTypedProperties(schema: ParsedSchema): Set<string> {
  const collected = new Set<string>();
  const seen = new Set<object>();
  const stack: ToolInputSchemaDefinition[] = [];
  if (schema !== undefined) {
    stack.push(schema);
  }

  for (const candidate of stack) {
    const unwrapped = unwrapJsonSchema(candidate);
    if (!unwrapped || typeof unwrapped !== "object" || seen.has(unwrapped)) {
      continue;
    }
    seen.add(unwrapped);
    collectObjectStringProperties(unwrapped, collected, stack);
    collectArrayItemSchemas(unwrapped, stack);
  }

  return collected;
}

export function processArrayContent(
  value: RxmlValue,
  schema: ParsedSchema,
  textNodeName: string
): RxmlValue {
  if (!Array.isArray(value)) {
    return value;
  }

  const stringItems = getSchemaType(schema) === "string";
  return value.map((item) => {
    if (typeof item === "string") {
      return item.trim();
    }
    if (isRxmlRecord(item) && textNodeName in item) {
      const textValue = item[textNodeName];
      if (typeof textValue === "string") {
        return textValue.trim();
      }
      return stringItems ? String(textValue) : textValue;
    }
    return stringItems ? String(item) : item;
  });
}

export function processIndexedTuple(
  objectValue: RxmlRecord,
  textNodeName: string
): RxmlValue[] {
  const keys = Object.keys(objectValue);
  const indices = keys
    .map((key) => Number.parseInt(key, 10))
    .sort((left, right) => left - right);
  const isValidTuple =
    indices[0] === 0 && indices.every((value, index) => value === index);

  if (!isValidTuple) {
    return [objectValue];
  }

  const sortedKeys = keys.sort(
    (left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10)
  );
  return sortedKeys.map((key) => {
    const item = objectValue[key];
    if (isRxmlRecord(item) && textNodeName in item) {
      const textValue = item[textNodeName];
      return typeof textValue === "string" ? textValue.trim() : textValue;
    }
    return typeof item === "string" ? item.trim() : item;
  });
}
