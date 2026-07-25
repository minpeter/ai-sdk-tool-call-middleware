import { unescapeXml } from "../../rxml/utils/helpers";
import { unwrapJsonSchema } from "../../schema-coerce";
import { escapeRegExp } from "../utils/regex";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";

// Module-level regex caches keyed by schema property name, mirroring
// selfClosingTagCache in xml-tool-tag-scanner.ts. These patterns are rebuilt
// on every streaming progress emission otherwise (once per chunk per
// property). The keyspace is bounded by schema property names seen by the
// process, so eviction is unnecessary. `lastIndex` is reset on every lookup
// so cached global-flag patterns always scan from the start.
function getCachedPattern(
  cache: Map<string, RegExp>,
  key: string,
  build: (escapedKey: string) => RegExp
): RegExp {
  let pattern = cache.get(key);
  if (!pattern) {
    pattern = build(escapeRegExp(key));
    cache.set(key, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

const propertyOpenOrSelfClosingTagCache = new Map<string, RegExp>();
const propertyOpenTagCache = new Map<string, RegExp>();
const propertyCloseTagCache = new Map<string, RegExp>();

function getPropertyOpenOrSelfClosingTagPattern(name: string): RegExp {
  return getCachedPattern(
    propertyOpenOrSelfClosingTagCache,
    name,
    (escaped) => new RegExp(`<${escaped}(?:\\s[^>]*)?\\s*/?>`, "i")
  );
}

function getPropertyOpenTagPattern(name: string): RegExp {
  return getCachedPattern(
    propertyOpenTagCache,
    name,
    (escaped) => new RegExp(`<${escaped}(?:\\s[^>]*)?>`, "gi")
  );
}

function getPropertyCloseTagPattern(name: string): RegExp {
  return getCachedPattern(
    propertyCloseTagCache,
    name,
    (escaped) => new RegExp(`</\\s*${escaped}\\s*>`, "gi")
  );
}

function parseXmlTagName(rawTagBody: string): string {
  let index = 0;
  while (
    index < rawTagBody.length &&
    WHITESPACE_REGEX.test(rawTagBody[index])
  ) {
    index += 1;
  }
  const nameStart = index;
  while (
    index < rawTagBody.length &&
    NAME_CHAR_RE.test(rawTagBody.charAt(index))
  ) {
    index += 1;
  }
  return rawTagBody.slice(nameStart, index);
}

type XmlSpecialConsumeResult =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "consumed"; nextPos: number };

function consumeXmlSpecialSection(
  fragment: string,
  ltIndex: number
): XmlSpecialConsumeResult {
  if (fragment.startsWith("<!--", ltIndex)) {
    const commentEnd = fragment.indexOf("-->", ltIndex + 4);
    return commentEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: commentEnd + 3 };
  }
  if (fragment.startsWith("<![CDATA[", ltIndex)) {
    const cdataEnd = fragment.indexOf("]]>", ltIndex + 9);
    return cdataEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: cdataEnd + 3 };
  }
  if (fragment.startsWith("<?", ltIndex)) {
    const processingEnd = fragment.indexOf("?>", ltIndex + 2);
    return processingEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: processingEnd + 2 };
  }
  if (fragment.startsWith("<!", ltIndex)) {
    const declarationEnd = fragment.indexOf(">", ltIndex + 2);
    return declarationEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: declarationEnd + 1 };
  }
  return { kind: "none" };
}

type XmlTagToken =
  | { kind: "close"; name: string; nextPos: number }
  | { kind: "open"; name: string; selfClosing: boolean; nextPos: number };

function parseXmlTagToken(
  fragment: string,
  ltIndex: number
): XmlTagToken | null {
  const gtIndex = fragment.indexOf(">", ltIndex + 1);
  if (gtIndex === -1) {
    return null;
  }

  const tagBody = fragment.slice(ltIndex + 1, gtIndex).trim();
  if (tagBody.length === 0) {
    return null;
  }

  if (tagBody.startsWith("/")) {
    const closeName = parseXmlTagName(tagBody.slice(1));
    if (closeName.length === 0) {
      return null;
    }
    return { kind: "close", name: closeName, nextPos: gtIndex + 1 };
  }

  const selfClosing = tagBody.endsWith("/");
  const openBody = selfClosing ? tagBody.slice(0, -1).trimEnd() : tagBody;
  const openName = parseXmlTagName(openBody);
  if (openName.length === 0) {
    return null;
  }
  return {
    kind: "open",
    name: openName,
    selfClosing,
    nextPos: gtIndex + 1,
  };
}

export function analyzeXmlFragmentForProgress(
  fragment: string
): { topLevelTagNames: string[] } | null {
  const stack: string[] = [];
  const topLevelTagNames: string[] = [];
  let position = 0;

  while (position < fragment.length) {
    const ltIndex = fragment.indexOf("<", position);
    if (ltIndex === -1) {
      break;
    }

    const special = consumeXmlSpecialSection(fragment, ltIndex);
    if (special.kind === "incomplete") {
      return null;
    }
    if (special.kind === "consumed") {
      position = special.nextPos;
      continue;
    }

    const token = parseXmlTagToken(fragment, ltIndex);
    if (token === null) {
      return null;
    }

    if (token.kind === "close") {
      const openName = stack.pop();
      if (!openName || openName !== token.name) {
        return null;
      }
      position = token.nextPos;
      continue;
    }

    if (stack.length === 0) {
      topLevelTagNames.push(token.name);
    }
    if (!token.selfClosing) {
      stack.push(token.name);
    }
    position = token.nextPos;
  }

  if (stack.length > 0) {
    return null;
  }

  return { topLevelTagNames };
}

type XmlTopLevelTextScanResult =
  | { kind: "found" }
  | { kind: "invalid" }
  | { kind: "next"; nextPos: number }
  | { kind: "done"; value: boolean };

function scanXmlFragmentTopLevelTextStep(options: {
  fragment: string;
  position: number;
  stack: string[];
}): XmlTopLevelTextScanResult {
  const { fragment, position, stack } = options;

  const ltIndex = fragment.indexOf("<", position);
  if (ltIndex === -1) {
    const trailingText = fragment.slice(position);
    return {
      kind: "done",
      value: stack.length === 0 && trailingText.trim().length > 0,
    };
  }

  const textBetweenTags = fragment.slice(position, ltIndex);
  if (stack.length === 0 && textBetweenTags.trim().length > 0) {
    return { kind: "found" };
  }

  const special = consumeXmlSpecialSection(fragment, ltIndex);
  if (special.kind === "incomplete") {
    return { kind: "invalid" };
  }
  if (special.kind === "consumed") {
    return { kind: "next", nextPos: special.nextPos };
  }

  const token = parseXmlTagToken(fragment, ltIndex);
  if (token === null) {
    return { kind: "invalid" };
  }

  if (token.kind === "close") {
    const openName = stack.pop();
    if (!openName || openName !== token.name) {
      return { kind: "invalid" };
    }
  } else if (!token.selfClosing) {
    stack.push(token.name);
  }

  return { kind: "next", nextPos: token.nextPos };
}

export function hasNonWhitespaceTopLevelText(fragment: string): boolean {
  if (!fragment.includes("<")) {
    return fragment.trim().length > 0;
  }

  const stack: string[] = [];
  let position = 0;

  while (position < fragment.length) {
    const step = scanXmlFragmentTopLevelTextStep({ fragment, position, stack });
    if (step.kind === "found") {
      return true;
    }
    if (step.kind === "invalid") {
      return false;
    }
    if (step.kind === "done") {
      return step.value;
    }

    position = step.nextPos;
  }

  return false;
}

// Schema introspection results are memoized by schema object identity.
// Tool input schemas are stable references for the lifetime of a request
// (tools are fixed when the stream parser is created), while these helpers
// are invoked on every streamed chunk from the tool-input progress path.
// WeakMap keying keeps the cache GC-safe. Returned Sets are shared across
// calls and must be treated as readonly by callers.
const objectSchemaPropertyNamesCache = new WeakMap<
  object,
  Set<string> | null
>();

export function getObjectSchemaPropertyNames(
  schema: unknown
): Set<string> | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const cached = objectSchemaPropertyNamesCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const result = computeObjectSchemaPropertyNames(schema);
  objectSchemaPropertyNamesCache.set(schema, result);
  return result;
}

function computeObjectSchemaPropertyNames(schema: object): Set<string> | null {
  const schemaObject = schema as {
    type?: unknown;
    properties?: unknown;
  };
  const typeValue = schemaObject.type;
  if (typeValue != null) {
    const isObjectType =
      typeValue === "object" ||
      (Array.isArray(typeValue) && typeValue.includes("object"));
    if (!isObjectType) {
      return null;
    }
  }
  if (!schemaObject.properties || typeof schemaObject.properties !== "object") {
    return new Set<string>();
  }

  return new Set(
    Object.keys(schemaObject.properties as Record<string, unknown>)
  );
}

const schemaAllowsArrayTypeCache = new WeakMap<object, boolean>();

export function schemaAllowsArrayType(schema: unknown): boolean {
  if (schema && typeof schema === "object") {
    const cached = schemaAllowsArrayTypeCache.get(schema);
    if (cached !== undefined) {
      return cached;
    }
    const result = computeSchemaAllowsArrayType(schema);
    schemaAllowsArrayTypeCache.set(schema, result);
    return result;
  }
  return computeSchemaAllowsArrayType(schema);
}

function computeSchemaAllowsArrayType(schema: unknown): boolean {
  const normalizedSchema = unwrapJsonSchema(schema);
  if (!normalizedSchema || typeof normalizedSchema !== "object") {
    return false;
  }

  const schemaRecord = normalizedSchema as Record<string, unknown>;
  const typeValue = schemaRecord.type;
  if (typeValue === "array") {
    return true;
  }
  if (Array.isArray(typeValue) && typeValue.includes("array")) {
    return true;
  }

  const unions = [schemaRecord.anyOf, schemaRecord.oneOf, schemaRecord.allOf];
  for (const union of unions) {
    if (!Array.isArray(union)) {
      continue;
    }
    if (union.some((entry) => schemaAllowsArrayType(entry))) {
      return true;
    }
  }

  return false;
}

function schemaAllowsStringType(schema: unknown): boolean {
  const normalizedSchema = unwrapJsonSchema(schema);
  if (!normalizedSchema || typeof normalizedSchema !== "object") {
    return false;
  }

  const schemaRecord = normalizedSchema as Record<string, unknown>;
  const typeValue = schemaRecord.type;
  if (typeValue === "string") {
    return true;
  }
  if (Array.isArray(typeValue) && typeValue.includes("string")) {
    return true;
  }

  const unions = [schemaRecord.anyOf, schemaRecord.oneOf, schemaRecord.allOf];
  for (const union of unions) {
    if (!Array.isArray(union)) {
      continue;
    }
    if (union.some((entry) => schemaAllowsStringType(entry))) {
      return true;
    }
  }

  return false;
}

const objectSchemaStringPropertyNamesCache = new WeakMap<
  object,
  Set<string> | null
>();

export function getObjectSchemaStringPropertyNames(
  schema: unknown
): Set<string> | null {
  if (schema && typeof schema === "object") {
    const cached = objectSchemaStringPropertyNamesCache.get(schema);
    if (cached !== undefined) {
      return cached;
    }
    const result = computeObjectSchemaStringPropertyNames(schema);
    objectSchemaStringPropertyNamesCache.set(schema, result);
    return result;
  }
  return computeObjectSchemaStringPropertyNames(schema);
}

function computeObjectSchemaStringPropertyNames(
  schema: unknown
): Set<string> | null {
  const propertyNames = getObjectSchemaPropertyNames(schema);
  if (!propertyNames) {
    return null;
  }

  const out = new Set<string>();
  for (const name of propertyNames) {
    const property = getSchemaObjectProperty(schema, name);
    if (schemaAllowsStringType(property)) {
      out.add(name);
    }
  }
  return out;
}

function getRequiredMessageStringProperty(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const schemaRecord = schema as Record<string, unknown>;
  const { required } = schemaRecord;
  if (
    !(
      Array.isArray(required) &&
      required.length === 1 &&
      required[0] === "message"
    )
  ) {
    return null;
  }

  const messageProperty = getSchemaObjectProperty(schema, "message");
  return schemaAllowsStringType(messageProperty) ? "message" : null;
}

function getOptionalMessageStringProperty(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const schemaRecord = schema as Record<string, unknown>;
  const { required } = schemaRecord;
  if (Array.isArray(required) && required.length > 0) {
    return null;
  }

  const messageProperty = getSchemaObjectProperty(schema, "message");
  return schemaAllowsStringType(messageProperty) ? "message" : null;
}

function getFallbackStringPropertyName(schema: unknown): string | null {
  return (
    getRequiredMessageStringProperty(schema) ??
    getOptionalMessageStringProperty(schema)
  );
}

interface ProtectedXmlText {
  marker: string;
  value: string;
}

const createProtectedXmlTextMarker = (
  source: string,
  index: number
): string => {
  let marker = `\u0000MORPH_XML_CDATA_${index}\u0000`;
  while (source.includes(marker)) {
    marker = `${marker}_`;
  }
  return marker;
};

const protectCdataText = (text: string): [string, ProtectedXmlText[]] => {
  const protectedTexts: ProtectedXmlText[] = [];
  const protectedSource = text.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (_match, value: string) => {
      const marker = createProtectedXmlTextMarker(text, protectedTexts.length);
      protectedTexts.push({ marker, value });
      return marker;
    }
  );
  return [protectedSource, protectedTexts];
};

const restoreProtectedXmlText = (
  text: string,
  protectedTexts: readonly ProtectedXmlText[]
): string => {
  let restored = text;
  for (const protectedText of protectedTexts) {
    restored = restored.replaceAll(protectedText.marker, protectedText.value);
  }
  return restored;
};

function stripXmlTagsFromTextBody(text: string): string {
  const [protectedSource, protectedTexts] = protectCdataText(text);
  const stripped = protectedSource
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<![^>]*>/g, "")
    .replace(/<\/?[a-z_][a-z0-9._:-]*(?:\s[^>]*)?\s*\/?>/gi, "");
  return restoreProtectedXmlText(stripped, protectedTexts);
}

export function plainTextBodyFallback(
  toolContent: string,
  toolSchema: unknown
): Record<string, string> | null {
  const normalizedSchema = unwrapJsonSchema(toolSchema);
  const propertyName = getFallbackStringPropertyName(normalizedSchema);
  if (!propertyName) {
    return null;
  }

  const normalized = toolContent.trim();
  if (!normalized) {
    return null;
  }

  const schemaProperties = getObjectSchemaPropertyNames(normalizedSchema);
  const allowsPlainTextWithSchemaTags =
    getRequiredMessageStringProperty(normalizedSchema) === propertyName;
  if (schemaProperties && !allowsPlainTextWithSchemaTags) {
    for (const name of schemaProperties) {
      const propertyTagPattern = getPropertyOpenOrSelfClosingTagPattern(name);
      if (propertyTagPattern.test(normalized)) {
        return null;
      }
    }
  }

  const structure = analyzeXmlFragmentForProgress(normalized);
  if (
    structure?.topLevelTagNames.some(
      (tagName) =>
        tagName === propertyName ||
        (schemaProperties?.has(tagName) && !allowsPlainTextWithSchemaTags)
    )
  ) {
    return null;
  }

  const recovered = unescapeXml(stripXmlTagsFromTextBody(normalized)).trim();
  if (!recovered) {
    return null;
  }

  return { [propertyName]: recovered };
}

export function findTrailingUnclosedStringTag(options: {
  toolContent: string;
  stringPropertyNames: Set<string>;
}): string | null {
  let bestName: string | null = null;
  let bestOpenIndex = -1;

  for (const name of options.stringPropertyNames) {
    const openPattern = getPropertyOpenTagPattern(name);
    const closePattern = getPropertyCloseTagPattern(name);

    let lastOpen = -1;
    for (const match of options.toolContent.matchAll(openPattern)) {
      const { index } = match;
      if (index !== undefined) {
        lastOpen = index;
      }
    }

    if (lastOpen === -1) {
      continue;
    }

    let lastClose = -1;
    for (const match of options.toolContent.matchAll(closePattern)) {
      const { index } = match;
      if (index !== undefined) {
        lastClose = index;
      }
    }

    if (lastOpen > lastClose && lastOpen > bestOpenIndex) {
      bestOpenIndex = lastOpen;
      bestName = name;
    }
  }

  return bestName;
}

export function buildEmptyTrailingStringTagProgressContent(options: {
  tagName: string;
  toolContent: string;
}): string | null {
  const openPattern = getPropertyOpenTagPattern(options.tagName);
  let lastOpenEnd = -1;

  for (const match of options.toolContent.matchAll(openPattern)) {
    const { index } = match;
    if (index !== undefined) {
      lastOpenEnd = index + match[0].length;
    }
  }

  if (lastOpenEnd === -1) {
    return null;
  }

  return `${options.toolContent.slice(0, lastOpenEnd)}</${options.tagName}>`;
}

export function getSchemaObjectProperty(
  schema: unknown,
  propertyName: string
): unknown | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const schemaObject = schema as Record<string, unknown>;
  const { properties } = schemaObject;
  if (!properties || typeof properties !== "object") {
    return null;
  }

  const property = (properties as Record<string, unknown>)[propertyName];
  if (!property) {
    return null;
  }

  return property;
}
