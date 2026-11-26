/**
 * Main XML parser that integrates tokenization, schema awareness, and error tolerance.
 */

import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import {
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
} from "../errors/types";
import {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
  processArrayContent,
  processIndexedTuple,
} from "../schema/coercion";
import { extractRawInner } from "../schema/extraction";
import {
  deepDecodeStringsBySchema,
  detectDuplicateTopLevelStringTags,
  getTopLevelStringProps,
  processItemWrapper,
  shieldStringTagsWithPlaceholders,
  unwrapSyntheticRootXml,
} from "./parse-preprocessing";
import { createPlaceholderRestorer } from "./placeholder-restorer";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

const DIGIT_KEY_REGEX = /^\d+$/;

function shouldRethrowParseError(
  error: unknown,
  xmlString: string
): error is RXMLParseError {
  if (!(error instanceof RXMLParseError)) {
    return false;
  }
  const isSimple = xmlString.split("<").length < 6;
  return (
    (error.message.includes("Unexpected close tag") && isSimple) ||
    (error.message.includes("Unclosed tag") && isSimple)
  );
}

function extractPartialXmlResults(
  xmlString: string,
  options: ParseOptions
): (RXMLNode | string)[] {
  const partialResults: (RXMLNode | string)[] = [];
  const xmlPattern = /<([a-zA-Z_][\w.-]*)[^>]*>.*?<\/\1>/gs;
  let match = xmlPattern.exec(xmlString);

  while (match !== null) {
    try {
      const [elementXml] = match;
      const tokenizer = new XMLTokenizer(elementXml, options);
      const parsed = tokenizer.parseChildren();
      partialResults.push(...parsed);
    } catch {
      // Ignore parse errors for individual elements
    }
    match = xmlPattern.exec(xmlString);
  }

  return partialResults;
}

function resolvePlaceholderStringValue(
  v: unknown,
  textNodeName: string,
  originalContentMap: Map<string, string>
): string | undefined {
  if (typeof v === "string" && v.startsWith("__RXML_PLACEHOLDER_")) {
    return originalContentMap.get(v);
  }
  if (
    v &&
    typeof v === "object" &&
    Object.hasOwn(v, textNodeName) &&
    typeof (v as Record<string, unknown>)[textNodeName] === "string" &&
    ((v as Record<string, unknown>)[textNodeName] as string).startsWith(
      "__RXML_PLACEHOLDER_"
    )
  ) {
    return originalContentMap.get(
      (v as Record<string, unknown>)[textNodeName] as string
    );
  }
  return undefined;
}

function resolveArrayStringProperty(options: {
  key: string;
  onError?: ParseOptions["onError"];
  textNodeName: string;
  throwDup: boolean;
  values: unknown[];
}): string {
  const mapped = options.values.map((item) => {
    if (
      item &&
      typeof item === "object" &&
      Object.hasOwn(item, options.textNodeName)
    ) {
      const textVal = (item as Record<string, unknown>)[options.textNodeName];
      return typeof textVal === "string" ? textVal : String(textVal);
    }
    return typeof item === "string" ? item : String(item);
  });

  if (mapped.length > 1 && options.throwDup) {
    throw new RXMLDuplicateStringTagError(
      `Duplicate string tags for <${options.key}> detected`
    );
  }
  if (mapped.length > 1 && !options.throwDup && options.onError) {
    options.onError(
      `RXML: Duplicate string tags for <${options.key}> detected; using first occurrence.`,
      { tag: options.key, occurrences: mapped.length }
    );
  }

  return mapped[0] ?? "";
}

function unwrapObjectNodeValue(
  obj: Record<string, unknown>,
  textNodeName: string
): unknown {
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === "item") {
    return processItemWrapper(obj.item, textNodeName);
  }
  if (keys.length > 0 && keys.every((key) => DIGIT_KEY_REGEX.test(key))) {
    const indices = keys
      .map((keyStr) => Number.parseInt(keyStr, 10))
      .sort((a, b) => a - b);
    const isIndexedTuple =
      indices[0] === 0 && indices.every((indexVal, idx) => indexVal === idx);
    if (isIndexedTuple) {
      return processIndexedTuple(obj, textNodeName);
    }
  }
  return obj;
}

/**
 * Parse XML with schema-aware type coercion.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Schema-aware XML assembly integrates placeholder restoration, duplicate checks, and tuple/item normalization.
export function parse(
  xmlInner: string,
  schema: unknown,
  options: ParseOptions = {}
): Record<string, unknown> {
  const textNodeName = options.textNodeName ?? "#text";
  const throwDup = options.throwOnDuplicateStringTags ?? true;

  const actualXmlInner = unwrapSyntheticRootXml(xmlInner, schema);
  const topLevelStringProps = getTopLevelStringProps(schema);
  const deepStringTypedProps = getStringTypedProperties(schema);

  const duplicateKeys = detectDuplicateTopLevelStringTags(
    actualXmlInner,
    topLevelStringProps,
    throwDup,
    options.onError
  );

  const { originalContentMap, xmlInnerForParsing } =
    shieldStringTagsWithPlaceholders(
      actualXmlInner,
      deepStringTypedProps,
      options.onError
    );

  let parsedNodes: (RXMLNode | string)[];
  try {
    const wrappedXml = `<root>${xmlInnerForParsing}</root>`;
    const tokenizer = new XMLTokenizer(wrappedXml, {
      ...options,
      textNodeName,
    });
    parsedNodes = tokenizer.parseNode().children;
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLParseError("Failed to parse XML", cause);
  }

  const parsedArgs = domToObject(parsedNodes, schema, textNodeName);
  const restorePlaceholdersDeep = createPlaceholderRestorer(
    originalContentMap,
    textNodeName
  );
  const parsedArgsRestored = restorePlaceholdersDeep(parsedArgs) as Record<
    string,
    unknown
  >;
  const args = Object.create(null) as Record<string, unknown>;

  for (const k of Object.keys(parsedArgsRestored || {})) {
    const v = parsedArgsRestored[k];
    let val: unknown = v;
    const propSchema = getPropertySchema(schema, k);
    const propType = getSchemaType(propSchema);

    if (propType === "string" && duplicateKeys.has(k) && Array.isArray(v)) {
      const [firstValue] = v;
      const restored = resolvePlaceholderStringValue(
        firstValue,
        textNodeName,
        originalContentMap
      );
      args[k] = restored ?? firstValue;
      continue;
    }

    if (propType === "string" && !Array.isArray(v)) {
      const restored = resolvePlaceholderStringValue(
        v,
        textNodeName,
        originalContentMap
      );
      if (restored !== undefined) {
        args[k] = restored;
        continue;
      }
      const raw = extractRawInner(actualXmlInner, k);
      if (typeof raw === "string") {
        args[k] = raw;
        continue;
      }
    }

    if (v && typeof v === "object" && Object.hasOwn(v, textNodeName)) {
      val = (v as Record<string, unknown>)[textNodeName];
    }

    if (Array.isArray(v)) {
      if (propType === "string") {
        args[k] = resolveArrayStringProperty({
          key: k,
          onError: options.onError,
          textNodeName,
          throwDup,
          values: v,
        });
        continue;
      }
      val = processArrayContent(v, propSchema, textNodeName);
    } else if (v && typeof v === "object" && !Object.hasOwn(v, textNodeName)) {
      val = unwrapObjectNodeValue(v as Record<string, unknown>, textNodeName);
    }

    args[k] = typeof val === "string" ? val.trim() : val;
  }

  for (const key of topLevelStringProps) {
    if (!Object.hasOwn(args, key)) {
      const raw = extractRawInner(actualXmlInner, key);
      if (typeof raw === "string") {
        args[key] = raw;
      }
    }
  }

  let dataToCoerce = args;
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const [rootKey] = keys;
    const unwrapped = unwrapJsonSchema(schema);
    if (unwrapped && typeof unwrapped === "object") {
      const schemaProps = (unwrapped as Record<string, unknown>).properties as
        | Record<string, unknown>
        | undefined;
      if (schemaProps && !Object.hasOwn(schemaProps, rootKey)) {
        dataToCoerce = args[rootKey] as Record<string, unknown>;
      }
    }
  }

  try {
    const coerced = coerceDomBySchema(dataToCoerce, schema);
    return deepDecodeStringsBySchema(coerced, schema) as Record<
      string,
      unknown
    >;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLCoercionError("Failed to coerce by schema", error);
  }
}

/**
 * Parse XML without schema (similar to TXML's parse function).
 */
export function parseWithoutSchema(
  xmlString: string,
  options: ParseOptions = {}
): (RXMLNode | string)[] {
  try {
    const tokenizer = new XMLTokenizer(xmlString, options);
    return tokenizer.parseChildren();
  } catch (error) {
    if (shouldRethrowParseError(error, xmlString)) {
      // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
      throw new RXMLParseError(
        error.message,
        error.cause,
        error.line,
        error.column
      );
    }

    if (options.onError) {
      options.onError("Failed to parse XML without schema", { error });
    }

    try {
      const partialResults = extractPartialXmlResults(xmlString, options);
      if (partialResults.length > 0) {
        return partialResults;
      }
    } catch {
      // Fallback failed too
    }

    return [xmlString.trim()];
  }
}

export function parseNode(
  xmlString: string,
  options: ParseOptions = {}
): RXMLNode {
  try {
    const tokenizer = new XMLTokenizer(xmlString, options);
    return tokenizer.parseNode();
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLParseError("Failed to parse XML node", error);
  }
}

function buildNodeValue(child: RXMLNode): unknown {
  const kids = simplify(child.children);
  let nodeValue: unknown = kids;

  if (Object.keys(child.attributes).length) {
    if (typeof kids === "string") {
      nodeValue =
        kids === ""
          ? { _attributes: child.attributes }
          : { _attributes: child.attributes, value: kids };
    } else if (typeof kids === "object" && kids !== null) {
      (kids as Record<string, unknown>)._attributes = child.attributes;
      nodeValue = kids;
    } else {
      nodeValue = { _attributes: child.attributes };
    }
  }

  return nodeValue;
}

export function simplify(children: (RXMLNode | string)[]): unknown {
  if (!children.length) {
    return "";
  }

  if (children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }

  const out: Record<string, unknown> = {};

  for (const child of children) {
    if (typeof child !== "object") {
      continue;
    }
    if (!out[child.tagName]) {
      out[child.tagName] = [];
    }
    (out[child.tagName] as unknown[]).push(buildNodeValue(child));
  }

  for (const key in out) {
    if (!Object.hasOwn(out, key)) {
      continue;
    }
    const value = out[key];
    if (Array.isArray(value) && value.length === 1) {
      out[key] = value[0];
    }
  }

  return out;
}

export function filter(
  children: (RXMLNode | string)[],
  filterFn: (
    node: RXMLNode,
    index: number,
    currentDepth: number,
    currentPath: string
  ) => boolean,
  depth = 0,
  path = ""
): RXMLNode[] {
  const out: RXMLNode[] = [];

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (typeof child === "object" && filterFn(child, i, depth, path)) {
      out.push(child);
    }
    if (typeof child === "object" && child.children) {
      const childPath = `${path ? `${path}.` : ""}${i}.${child.tagName}`;
      out.push(...filter(child.children, filterFn, depth + 1, childPath));
    }
  }

  return out;
}
