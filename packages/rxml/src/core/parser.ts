/**
 * Main XML parser that integrates tokenization, schema awareness, and error tolerance
 * This replaces the fast-xml-parser dependency with a TXML-based implementation
 */

import {
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
} from "../errors/types";
import { getSchemaType, unwrapJsonSchema } from "../schema/base-coercion";

// Regex constants for performance
const WHITESPACE_REGEX = /\s/;
const NUMERIC_STRING_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DIGIT_KEY_REGEX = /^\d+$/;

/**
 * Extract top-level string-typed properties from a schema
 */
function getTopLevelStringProps(s: unknown): Set<string> {
  const set = new Set<string>();
  const unwrapped = unwrapJsonSchema(s);
  if (unwrapped && typeof unwrapped === "object") {
    const props = (unwrapped as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    if (props && typeof props === "object") {
      for (const [k, v] of Object.entries(props)) {
        if (getSchemaType(v) === "string") {
          set.add(k);
        }
      }
    }
  }
  return set;
}

/**
 * Restore a single string value from placeholder if needed
 */
function restorePlaceholderString(
  val: string,
  placeholderMap: Map<string, string>
): string {
  if (val.startsWith("__RXML_PLACEHOLDER_")) {
    const orig = placeholderMap.get(val);
    return orig !== undefined ? orig : val;
  }
  return val;
}

/**
 * Restore placeholders in an object
 */
function restorePlaceholdersInObject(
  obj: Record<string, unknown>,
  _placeholderMap: Map<string, string>,
  textNodeName: string,
  restorer: (val: unknown) => unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const restored = restorer(v);
    // Trim when restoring into text node field to match tokenizer's default trimming
    if (k === textNodeName && typeof restored === "string") {
      out[k] = restored.trim();
    } else {
      out[k] = restored;
    }
  }
  return out;
}

/**
 * Create a function to restore placeholders deeply in parsed structure
 */
function createPlaceholderRestorer(
  placeholderMap: Map<string, string>,
  textNodeName: string
): (val: unknown) => unknown {
  const restorer = (val: unknown): unknown => {
    if (val == null) {
      return val;
    }
    if (typeof val === "string") {
      return restorePlaceholderString(val, placeholderMap);
    }
    if (Array.isArray(val)) {
      return val.map(restorer);
    }
    if (typeof val === "object") {
      return restorePlaceholdersInObject(
        val as Record<string, unknown>,
        placeholderMap,
        textNodeName,
        restorer
      );
    }
    return val;
  };
  return restorer;
}

/**
 * Convert a value to a number if it matches numeric pattern
 */
function tryConvertToNumber(val: unknown): unknown {
  if (typeof val !== "string") {
    return val;
  }
  const trimmed = val.trim();
  if (NUMERIC_STRING_REGEX.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return trimmed;
}

/**
 * Process a single item value, extracting text content and converting numbers
 */
function processItemValue(item: unknown, textNodeName: string): unknown {
  let currentVal: unknown = item;
  if (item && typeof item === "object" && Object.hasOwn(item, textNodeName)) {
    currentVal = (item as Record<string, unknown>)[textNodeName];
  }
  const trimmed =
    typeof currentVal === "string" ? currentVal.trim() : currentVal;
  return tryConvertToNumber(trimmed);
}

/**
 * Process item wrapper pattern values
 */
function processItemWrapper(itemValue: unknown, textNodeName: string): unknown {
  if (Array.isArray(itemValue)) {
    return itemValue.map((item) => processItemValue(item, textNodeName));
  }
  const trimmed = typeof itemValue === "string" ? itemValue.trim() : itemValue;
  return tryConvertToNumber(trimmed);
}

/**
 * Check if error should be re-thrown based on error type and XML simplicity
 */
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

/**
 * Try to extract partial XML results from malformed XML
 */
function extractPartialXmlResults(
  xmlString: string,
  options: ParseOptions
): (RXMLNode | string)[] {
  const partialResults: (RXMLNode | string)[] = [];
  const xmlPattern = /<([a-zA-Z_][\w.-]*)[^>]*>.*?<\/\1>/gs;
  let match: RegExpExecArray | null = null;

  match = xmlPattern.exec(xmlString);
  while (match !== null) {
    try {
      const elementXml = match[0];
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

import {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
  processArrayContent,
  processIndexedTuple,
} from "../schema/coercion";
import {
  countTagOccurrences,
  extractRawInner,
  findAllInnerRanges,
  findFirstTopLevelRange,
} from "../schema/extraction";
import { unescapeXml } from "../utils/helpers";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

// Internal: schema-guided deep XML entity decoding
function deepDecodeStringsBySchema(input: unknown, schema: unknown): unknown {
  if (input == null || schema == null) {
    return input;
  }

  const type = getSchemaType(schema);

  if (type === "string" && typeof input === "string") {
    return unescapeXml(input);
  }

  if (type === "array" && Array.isArray(input)) {
    const unwrapped = unwrapJsonSchema(schema) as
      | { items?: unknown }
      | undefined;
    const itemSchema = unwrapped?.items ?? {};
    return input.map((item) => deepDecodeStringsBySchema(item, itemSchema));
  }

  if (type === "object" && input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const childSchema = getPropertySchema(schema, key);
      out[key] = deepDecodeStringsBySchema(obj[key], childSchema);
    }
    return out;
  }

  // Fallback: decode any string when schema typing is ambiguous/missing
  if (typeof input === "string") {
    return unescapeXml(input);
  }
  return input;
}

/**
 * Parse XML with schema-aware type coercion
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function handles complex XML parsing logic that is difficult to break down further without losing clarity
export function parse(
  xmlInner: string,
  schema: unknown,
  options: ParseOptions = {}
): Record<string, unknown> {
  const textNodeName = options.textNodeName ?? "#text";
  const throwDup = options.throwOnDuplicateStringTags ?? true;

  // If xmlInner looks like a full XML document (single root element), extract its inner content
  // But only if the schema doesn't expect that root element. Use a parser-style scan for robustness.
  let actualXmlInner = xmlInner.trim();
  if (actualXmlInner.startsWith("<") && actualXmlInner.endsWith(">")) {
    const s = actualXmlInner;
    let i = 0;
    let rootStart = -1;
    let rootName = "";

    while (i < s.length) {
      const lt = s.indexOf("<", i);
      if (lt === -1) {
        break;
      }
      const next = s[lt + 1];
      if (next === "?") {
        const end = s.indexOf("?>", lt + 2);
        i = end === -1 ? s.length : end + 2;
        continue;
      }
      if (next === "!") {
        if (s.startsWith("!--", lt + 2)) {
          const end = s.indexOf("-->", lt + 5);
          i = end === -1 ? s.length : end + 3;
          continue;
        }
        if (s.startsWith("![CDATA[", lt + 2)) {
          const end = s.indexOf("]]>", lt + 9);
          i = end === -1 ? s.length : end + 3;
          continue;
        }
        const end = s.indexOf(">", lt + 2);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      if (next === "/") {
        // unexpected close before open; treat as not-a-root document
        break;
      }
      // Found a start tag; parse name until whitespace, '/', or '>'
      let j = lt + 1;
      while (
        j < s.length &&
        s[j] !== " " &&
        s[j] !== "\n" &&
        s[j] !== "\r" &&
        s[j] !== "\t" &&
        s[j] !== "/" &&
        s[j] !== ">"
      ) {
        j += 1;
      }
      rootStart = lt;
      rootName = s.slice(lt + 1, j);
      break;
    }

    if (rootStart === 0 && rootName) {
      const range = findFirstTopLevelRange(s, rootName);
      if (range) {
        // Compute full closing tag end index allowing whitespace before '>'
        let fullEnd = range.end + `</${rootName}>`.length;
        const closeHead = s.indexOf(`</${rootName}`, range.end);
        if (closeHead === range.end) {
          let p = closeHead + 2 + rootName.length;
          while (p < s.length && WHITESPACE_REGEX.test(s[p])) {
            p += 1;
          }
          if (s[p] === ">") {
            fullEnd = p + 1;
          }
        }

        if (fullEnd === s.length) {
          // Check if the schema expects this root tag
          const unwrapped = unwrapJsonSchema(schema);
          const schemaProps =
            unwrapped && typeof unwrapped === "object"
              ? ((unwrapped as Record<string, unknown>).properties as
                  | Record<string, unknown>
                  | undefined)
              : undefined;

          if (schemaProps && !Object.hasOwn(schemaProps, rootName)) {
            actualXmlInner = s.slice(range.start, range.end);
          }
        }
      }
    }
  }

  // Identify string-typed properties for special handling
  // Use top-level keys for duplicate detection/backfill, deep keys for placeholder shielding
  const topLevelStringProps = getTopLevelStringProps(schema);
  const deepStringTypedProps = getStringTypedProperties(schema);

  // First, check for duplicates before doing any placeholder replacement
  const duplicateKeys = new Set<string>();
  for (const key of topLevelStringProps) {
    const excludeRanges: Array<{ start: number; end: number }> = [];
    for (const other of topLevelStringProps) {
      if (other === key) {
        continue;
      }
      const range = findFirstTopLevelRange(actualXmlInner, other);
      if (range) {
        excludeRanges.push(range);
      }
    }

    const occurrences = countTagOccurrences(
      actualXmlInner,
      key,
      excludeRanges,
      true
    );

    if (occurrences > 0 && throwDup) {
      throw new RXMLDuplicateStringTagError(
        `Duplicate string tags for <${key}> detected`
      );
    }
    if (occurrences > 0 && !throwDup) {
      duplicateKeys.add(key);
      if (options.onError) {
        options.onError(
          `RXML: Duplicate string tags for <${key}> detected; using first occurrence.`,
          { tag: key, occurrences }
        );
      }
    }
  }

  // Replace inner content of string-typed tags with placeholders to avoid
  // XML parsing errors from constructs like <!DOCTYPE ...> within element bodies
  let xmlInnerForParsing = actualXmlInner;
  const originalContentMap = new Map<string, string>();
  try {
    // Collect ranges of all occurrences for each string-typed tag name (at any depth)
    const ranges: Array<{ start: number; end: number; key: string }> = [];
    for (const key of deepStringTypedProps) {
      const innerRanges = findAllInnerRanges(actualXmlInner, key);
      for (const r of innerRanges) {
        if (r.end > r.start) {
          ranges.push({ ...r, key });
        }
      }
    }

    if (ranges.length > 0) {
      // Sort by start index and replace from left to right
      const sorted = [...ranges].sort((a, b) => a.start - b.start);
      let rebuilt = "";
      let cursor = 0;
      for (const r of sorted) {
        if (r.start < cursor) {
          // Overlapping range (nested); skip, as outer replacement already handled it
          continue;
        }
        if (cursor < r.start) {
          rebuilt += actualXmlInner.slice(cursor, r.start);
        }
        const placeholder = `__RXML_PLACEHOLDER_${r.key}_${r.start}_${r.end}__`;
        const originalContent = actualXmlInner.slice(r.start, r.end);
        originalContentMap.set(placeholder, originalContent);
        rebuilt += placeholder;
        cursor = r.end;
      }
      if (cursor < actualXmlInner.length) {
        rebuilt += actualXmlInner.slice(cursor);
      }
      xmlInnerForParsing = rebuilt;
    }
  } catch (error) {
    // Non-fatal: fall back to original XML; allow caller to handle via onError
    if (options.onError) {
      options.onError(
        "RXML: Failed to replace string placeholders, falling back to original XML.",
        { error }
      );
    }
    xmlInnerForParsing = actualXmlInner;
  }

  // Parse XML using our TXML-based tokenizer
  let parsedNodes: (RXMLNode | string)[];
  try {
    const wrappedXml = `<root>${xmlInnerForParsing}</root>`;
    const tokenizer = new XMLTokenizer(wrappedXml, {
      ...options,
      textNodeName,
    });
    const rootNode = tokenizer.parseNode();

    // Extract content from root wrapper
    parsedNodes = rootNode.children;
  } catch (cause) {
    throw new RXMLParseError("Failed to parse XML", cause);
  }

  // Convert DOM to flat object structure
  const parsedArgs = domToObject(parsedNodes, schema, textNodeName);

  // Restore any placeholders across the entire parsed structure before schema-aware processing
  const restorePlaceholdersDeep = createPlaceholderRestorer(
    originalContentMap,
    textNodeName
  );
  const parsedArgsRestored = restorePlaceholdersDeep(parsedArgs) as Record<
    string,
    unknown
  >;
  const args: Record<string, unknown> = {};

  // Process each property with schema-aware handling
  for (const k of Object.keys(parsedArgsRestored || {})) {
    const v = parsedArgsRestored[k];
    let val: unknown = v;
    const propSchema = getPropertySchema(schema, k);
    const propType = getSchemaType(propSchema);

    // Handle duplicates when throwOnDuplicateStringTags is false
    if (propType === "string" && duplicateKeys.has(k) && Array.isArray(v)) {
      // For duplicates, use the first occurrence
      const firstValue = v[0];
      if (
        typeof firstValue === "string" &&
        firstValue.startsWith("__RXML_PLACEHOLDER_")
      ) {
        // Restore from placeholder
        const originalContent = originalContentMap.get(firstValue);
        if (originalContent !== undefined) {
          args[k] = originalContent;
          continue;
        }
      } else {
        args[k] = firstValue;
        continue;
      }
    }

    if (propType === "string" && !Array.isArray(v)) {
      // First, check if this is a placeholder value and restore original content
      const placeholderUsed =
        (typeof v === "string" && v.startsWith("__RXML_PLACEHOLDER_")) ||
        (v &&
          typeof v === "object" &&
          Object.hasOwn(v, textNodeName) &&
          typeof (v as Record<string, unknown>)[textNodeName] === "string" &&
          ((v as Record<string, unknown>)[textNodeName] as string).startsWith(
            "__RXML_PLACEHOLDER_"
          ));

      if (placeholderUsed) {
        // Extract the original content from the placeholder map
        let placeholderKey: string;
        if (typeof v === "string") {
          placeholderKey = v;
        } else {
          placeholderKey = (v as Record<string, unknown>)[
            textNodeName
          ] as string;
        }

        const originalContent = originalContentMap.get(placeholderKey);
        if (originalContent !== undefined) {
          args[k] = originalContent;
          continue;
        }
      }

      // Try to extract raw content (duplicates already handled earlier)
      const raw = extractRawInner(actualXmlInner, k);
      if (typeof raw === "string") {
        args[k] = raw;
        continue;
      }
    }

    // Extract text content from wrapped objects
    if (v && typeof v === "object" && Object.hasOwn(v, textNodeName)) {
      val = (v as Record<string, unknown>)[textNodeName];
    }

    // Handle array content
    if (Array.isArray(v)) {
      if (propType === "string") {
        const mapped = v.map((item) => {
          if (
            item &&
            typeof item === "object" &&
            Object.hasOwn(item, textNodeName)
          ) {
            const textVal = (item as Record<string, unknown>)[textNodeName];
            return typeof textVal === "string" ? textVal : String(textVal);
          }
          return typeof item === "string" ? item : String(item);
        });

        if (mapped.length > 1 && throwDup) {
          throw new RXMLDuplicateStringTagError(
            `Duplicate string tags for <${k}> detected`
          );
        }
        if (mapped.length > 1 && !throwDup && options.onError) {
          options.onError(
            `RXML: Duplicate string tags for <${k}> detected; using first occurrence.`,
            { tag: k, occurrences: mapped.length }
          );
        }

        args[k] = mapped[0] ?? "";
        continue;
      }
      val = processArrayContent(v, propSchema, textNodeName);
    } else if (v && typeof v === "object" && !Object.hasOwn(v, textNodeName)) {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);

      // Handle <item> wrapper pattern
      if (keys.length === 1 && keys[0] === "item") {
        val = processItemWrapper(obj.item, textNodeName);
      } else {
        // Check for indexed tuple pattern (numeric keys)
        let isIndexedTuple = false;
        if (keys.length > 0 && keys.every((key) => DIGIT_KEY_REGEX.test(key))) {
          const indices = keys
            .map((keyStr) => Number.parseInt(keyStr, 10))
            .sort((a, b) => a - b);
          isIndexedTuple =
            indices[0] === 0 &&
            indices.every((indexVal, idx) => indexVal === idx);
        }

        if (isIndexedTuple) {
          val = processIndexedTuple(obj, textNodeName);
        } else {
          val = v;
        }
      }
    }

    args[k] = typeof val === "string" ? val.trim() : val;
  }

  // Ensure missing string-typed properties are populated from original XML
  for (const key of topLevelStringProps) {
    if (!Object.hasOwn(args, key)) {
      const raw = extractRawInner(actualXmlInner, key);
      if (typeof raw === "string") {
        args[key] = raw;
      }
    }
  }

  // Auto-unwrap single root element if schema doesn't expect it (before coercion)
  let dataToCoerce = args;
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const rootKey = keys[0];
    const rootValue = args[rootKey];

    // Check if schema expects the root key
    const unwrapped = unwrapJsonSchema(schema);
    if (unwrapped && typeof unwrapped === "object") {
      const schemaProps = (unwrapped as Record<string, unknown>).properties as
        | Record<string, unknown>
        | undefined;
      if (schemaProps && !Object.hasOwn(schemaProps, rootKey)) {
        // Schema doesn't expect the root key, so unwrap it before coercion
        dataToCoerce = rootValue as Record<string, unknown>;
      }
    }
  }

  // Apply schema-based coercion
  try {
    const coerced = coerceDomBySchema(dataToCoerce, schema);
    const decoded = deepDecodeStringsBySchema(coerced, schema) as Record<
      string,
      unknown
    >;
    return decoded;
  } catch (error) {
    throw new RXMLCoercionError("Failed to coerce by schema", error);
  }
}

/**
 * Parse XML without schema (similar to TXML's parse function)
 */
export function parseWithoutSchema(
  xmlString: string,
  options: ParseOptions = {}
): (RXMLNode | string)[] {
  try {
    const tokenizer = new XMLTokenizer(xmlString, options);
    return tokenizer.parseChildren();
  } catch (error) {
    // Check if this is a specific type of error that should be re-thrown
    if (shouldRethrowParseError(error, xmlString)) {
      // Preserve the original error message and line/column information
      throw new RXMLParseError(
        error.message,
        error.cause,
        error.line,
        error.column
      );
    }

    // For other types of malformed XML, try to be more tolerant and return partial results
    if (options.onError) {
      options.onError("Failed to parse XML without schema", { error });
    }

    // Try to extract any valid XML elements that we can parse
    try {
      const partialResults = extractPartialXmlResults(xmlString, options);
      if (partialResults.length > 0) {
        return partialResults;
      }
    } catch {
      // Fallback failed too
    }

    // Last resort: return the input as text content
    return [xmlString.trim()];
  }
}

/**
 * Parse a single XML node
 */
export function parseNode(
  xmlString: string,
  options: ParseOptions = {}
): RXMLNode {
  try {
    const tokenizer = new XMLTokenizer(xmlString, options);
    return tokenizer.parseNode();
  } catch (error) {
    throw new RXMLParseError("Failed to parse XML node", error);
  }
}

/**
 * Build node value with attributes if present
 */
function buildNodeValue(child: RXMLNode): unknown {
  const kids = simplify(child.children);
  let nodeValue: unknown = kids;

  // Add attributes if present
  if (Object.keys(child.attributes).length) {
    if (typeof kids === "string") {
      nodeValue = kids;
      // For string content with attributes, we need to preserve both
      if (kids !== "") {
        nodeValue = { _attributes: child.attributes, value: kids };
      } else {
        nodeValue = { _attributes: child.attributes };
      }
    } else if (typeof kids === "object" && kids !== null) {
      (kids as Record<string, unknown>)._attributes = child.attributes;
      nodeValue = kids;
    } else {
      nodeValue = { _attributes: child.attributes };
    }
  }

  return nodeValue;
}

/**
 * Simplify parsed XML structure (similar to TXML's simplify)
 */
export function simplify(children: (RXMLNode | string)[]): unknown {
  if (!children.length) {
    return "";
  }

  if (children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }

  const out: Record<string, unknown> = {};

  // Map each object
  for (const child of children) {
    if (typeof child !== "object") {
      continue;
    }

    if (!out[child.tagName]) {
      out[child.tagName] = [];
    }

    const nodeValue = buildNodeValue(child);
    (out[child.tagName] as unknown[]).push(nodeValue);
  }

  // Flatten single-item arrays
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

/**
 * Filter XML nodes (similar to TXML's filter)
 */
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
      const kids = filter(child.children, filterFn, depth + 1, childPath);
      out.push(...kids);
    }
  }

  return out;
}
