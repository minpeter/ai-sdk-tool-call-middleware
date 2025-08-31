/**
 * Main XML parser that integrates tokenization, schema awareness, and error tolerance
 * This replaces the fast-xml-parser dependency with a TXML-based implementation
 */

import { getSchemaType, unwrapJsonSchema } from "@/utils/coercion";

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
import {
  countTagOccurrences,
  extractRawInner,
  findFirstTopLevelRange,
} from "../schema/extraction";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

/**
 * Parse XML with schema-aware type coercion
 */
export function parse(
  xmlInner: string,
  schema: unknown,
  options: ParseOptions = {}
): Record<string, unknown> {
  const textNodeName = options.textNodeName ?? "#text";
  const throwDup = options.throwOnDuplicateStringTags ?? true;

  // If xmlInner looks like a full XML document (single root element), extract its inner content
  // But only if the schema doesn't expect that root element
  let actualXmlInner = xmlInner.trim();
  if (actualXmlInner.startsWith("<") && actualXmlInner.endsWith(">")) {
    // Use a simple regex approach to extract inner content while preserving formatting
    const match = actualXmlInner.match(/^<([^>\s]+)(?:\s[^>]*)?>(.+)<\/\1>$/s);
    if (match) {
      const rootTagName = match[1];
      const innerContent = match[2];

      // Check if the schema expects this root tag
      const unwrapped = unwrapJsonSchema(schema);
      const schemaProps =
        unwrapped && typeof unwrapped === "object"
          ? ((unwrapped as Record<string, unknown>).properties as
              | Record<string, unknown>
              | undefined)
          : undefined;

      // Only unwrap if the schema doesn't expect the root tag
      if (
        schemaProps &&
        !Object.prototype.hasOwnProperty.call(schemaProps, rootTagName)
      ) {
        actualXmlInner = innerContent;
      }
      // Otherwise keep the original XML as-is
    }
    // If regex doesn't match, fall back to using the original input
    // This handles cases where xmlInner is already inner content
  }

  // Identify string-typed properties for special handling
  const stringTypedProps = getStringTypedProperties(schema);

  // First, check for duplicates before doing any placeholder replacement
  const duplicateKeys = new Set<string>();
  for (const key of stringTypedProps) {
    const excludeRanges: Array<{ start: number; end: number }> = [];
    for (const other of stringTypedProps) {
      if (other === key) continue;
      const range = findFirstTopLevelRange(actualXmlInner, other);
      if (range) excludeRanges.push(range);
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
    const ranges: Array<{ start: number; end: number; key: string }> = [];

    for (const key of stringTypedProps) {
      // Find the range for placeholder replacement
      const r = findFirstTopLevelRange(actualXmlInner, key);
      if (r && r.end > r.start) ranges.push({ ...r, key });
    }

    if (ranges.length > 0) {
      ranges.sort((a, b) => a.start - b.start);
      let rebuilt = "";
      let cursor = 0;
      for (const r of ranges) {
        if (cursor < r.start) rebuilt += actualXmlInner.slice(cursor, r.start);
        const placeholder = `__RXML_PLACEHOLDER_${r.key}__`;
        const originalContent = actualXmlInner.slice(r.start, r.end);
        originalContentMap.set(placeholder, originalContent);
        rebuilt += placeholder;
        cursor = r.end;
      }
      if (cursor < actualXmlInner.length)
        rebuilt += actualXmlInner.slice(cursor);
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
  const args: Record<string, unknown> = {};

  // Process each property with schema-aware handling
  for (const k of Object.keys(parsedArgs || {})) {
    const v = parsedArgs[k];
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
          Object.prototype.hasOwnProperty.call(v, textNodeName) &&
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

        // Find the original content from the ranges that were replaced
        const originalContent = originalContentMap.get(placeholderKey);

        if (originalContent !== undefined) {
          // originalContent is already the inner content from findFirstTopLevelRange
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
    if (
      v &&
      typeof v === "object" &&
      Object.prototype.hasOwnProperty.call(v, textNodeName)
    ) {
      val = (v as Record<string, unknown>)[textNodeName];
    }

    // Handle array content
    if (Array.isArray(v)) {
      if (propType === "string") {
        const mapped = v.map(item => {
          if (
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, textNodeName)
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
      } else {
        val = processArrayContent(v, propSchema, textNodeName);
      }
    } else if (
      v &&
      typeof v === "object" &&
      !Object.prototype.hasOwnProperty.call(v, textNodeName)
    ) {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);

      // Handle <item> wrapper pattern
      if (keys.length === 1 && keys[0] === "item") {
        const itemValue = obj.item;
        if (Array.isArray(itemValue)) {
          val = itemValue.map(item => {
            let currentVal: unknown = item;
            if (
              item &&
              typeof item === "object" &&
              Object.prototype.hasOwnProperty.call(item, textNodeName)
            ) {
              currentVal = (item as Record<string, unknown>)[textNodeName];
            }
            const trimmed =
              typeof currentVal === "string" ? currentVal.trim() : currentVal;

            // Auto-convert numeric strings
            if (
              typeof trimmed === "string" &&
              /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
            ) {
              const num = Number(trimmed);
              if (Number.isFinite(num)) return num;
            }
            return trimmed;
          });
        } else {
          const trimmed =
            typeof itemValue === "string" ? itemValue.trim() : itemValue;
          if (
            typeof trimmed === "string" &&
            /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
          ) {
            const num = Number(trimmed);
            val = Number.isFinite(num) ? num : trimmed;
          } else {
            val = trimmed;
          }
        }
      } else {
        // Check for indexed tuple pattern (numeric keys)
        let isIndexedTuple = false;
        if (keys.length > 0 && keys.every(key => /^\d+$/.test(key))) {
          const indices = keys.map(k => parseInt(k, 10)).sort((a, b) => a - b);
          isIndexedTuple =
            indices[0] === 0 && indices.every((val, idx) => val === idx);
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
      if (
        schemaProps &&
        !Object.prototype.hasOwnProperty.call(schemaProps, rootKey)
      ) {
        // Schema doesn't expect the root key, so unwrap it before coercion
        dataToCoerce = rootValue as Record<string, unknown>;
      }
    }
  }

  // Apply schema-based coercion
  try {
    const coerced = coerceDomBySchema(dataToCoerce, schema);
    return coerced;
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
    if (error instanceof RXMLParseError) {
      const isSimple = xmlString.split("<").length < 6;

      // Re-throw errors for clearly invalid XML structures in simple cases
      // 1. Mismatched tags (like <item>content</wrong>)
      // 2. Unclosed tags at end of input (like <root><item>text)
      if (
        (error.message.includes("Unexpected close tag") && isSimple) ||
        (error.message.includes("Unclosed tag") && isSimple)
      ) {
        // Preserve the original error message and line/column information
        throw new RXMLParseError(
          error.message,
          error.cause,
          error.line,
          error.column
        );
      }
    }

    // For other types of malformed XML, try to be more tolerant and return partial results
    // This matches the expected behavior of being "robust" with malformed XML
    if (options.onError) {
      options.onError("Failed to parse XML without schema", { error });
    }

    // Try to extract any valid XML elements that we can parse
    try {
      const partialResults: (RXMLNode | string)[] = [];

      // Look for complete XML elements in the string
      const xmlPattern = /<([a-zA-Z_][\w.-]*)[^>]*>.*?<\/\1>/gs;
      let match;

      while ((match = xmlPattern.exec(xmlString)) !== null) {
        try {
          const elementXml = match[0];
          const tokenizer = new XMLTokenizer(elementXml, options);
          const parsed = tokenizer.parseChildren();
          partialResults.push(...parsed);
        } catch {
          // Skip this element if it can't be parsed
          continue;
        }
      }

      // If we found some valid elements, return them
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
  children.forEach(child => {
    if (typeof child !== "object") {
      return;
    }

    if (!out[child.tagName]) {
      out[child.tagName] = [];
    }

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

    (out[child.tagName] as unknown[]).push(nodeValue);
  });

  // Flatten single-item arrays
  for (const key in out) {
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
    depth: number,
    path: string
  ) => boolean,
  depth = 0,
  path = ""
): RXMLNode[] {
  const out: RXMLNode[] = [];

  children.forEach((child, i) => {
    if (typeof child === "object" && filterFn(child, i, depth, path)) {
      out.push(child);
    }
    if (typeof child === "object" && child.children) {
      const kids = filter(
        child.children,
        filterFn,
        depth + 1,
        (path ? path + "." : "") + i + "." + child.tagName
      );
      out.push(...kids);
    }
  });

  return out;
}
