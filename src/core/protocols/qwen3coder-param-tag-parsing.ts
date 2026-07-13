import { unescapeXml } from "../../rxml/utils/helpers";
import { escapeRegExp } from "../utils/regex";
import {
  CALL_SHORTHAND_VALUE_RE,
  isAsciiWhitespace,
  isTagBoundaryChar,
  isTagNameBoundaryChar,
  QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES,
  QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES,
  skipAsciiWhitespace,
} from "./qwen3coder-call-syntax";

export function findTagEndIndex(
  text: string,
  startIndex: number
): number | null {
  let quote: '"' | "'" | null = null;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return i;
    }
  }
  return null;
}

export function parseShorthandValue(
  openTag: string,
  tagNameLower: string
): string | null {
  let i = 1;
  i = skipAsciiWhitespace(openTag, i);
  if (!openTag.toLowerCase().startsWith(tagNameLower, i)) {
    return null;
  }
  i += tagNameLower.length;
  i = skipAsciiWhitespace(openTag, i);
  if (openTag[i] !== "=") {
    return null;
  }
  i += 1;
  i = skipAsciiWhitespace(openTag, i);

  const quote = openTag[i] ?? "";
  if (quote === '"' || quote === "'") {
    const end = openTag.indexOf(quote, i + 1);
    if (end === -1) {
      return null;
    }
    return openTag.slice(i + 1, end);
  }

  const start = i;
  while (i < openTag.length) {
    const ch = openTag[i] ?? "";
    if (isAsciiWhitespace(ch) || ch === ">" || ch === "/") {
      break;
    }
    i += 1;
  }
  const value = openTag.slice(start, i);
  return value.length > 0 ? value : null;
}

function parseQwen3CoderToolParserParamName(
  openTag: string,
  tagNameLower: string
): string | null {
  const shorthand = parseShorthandValue(openTag, tagNameLower);
  if (shorthand != null) {
    return unescapeXml(shorthand);
  }

  return getAttributeValue(openTag, "name");
}

function getCdataSectionNextIndex(
  textLower: string,
  startIndex: number
): number | null {
  if (!textLower.startsWith("<![cdata[", startIndex)) {
    return startIndex;
  }
  const cdataEnd = textLower.indexOf("]]>", startIndex + "<![cdata[".length);
  if (cdataEnd === -1) {
    return null;
  }
  return cdataEnd + 3;
}

function parseMatchingTagHeader(
  textLower: string,
  lt: number,
  tagNameLower: string
): { isClosing: boolean; afterName: number } | null {
  let i = skipAsciiWhitespace(textLower, lt + 1);
  const isClosing = textLower[i] === "/";
  if (isClosing) {
    i += 1;
    i = skipAsciiWhitespace(textLower, i);
  }
  if (!textLower.startsWith(tagNameLower, i)) {
    return null;
  }

  const afterName = i + tagNameLower.length;
  const boundary = textLower[afterName] ?? "";
  const validBoundary = isClosing
    ? isTagBoundaryChar(boundary)
    : isTagBoundaryChar(boundary) || boundary === "=";
  if (boundary && !validBoundary) {
    return null;
  }

  return { isClosing, afterName };
}

function isSelfClosingXmlTag(
  textLower: string,
  lt: number,
  gt: number
): boolean {
  return textLower
    .slice(lt, gt + 1)
    .trimEnd()
    .endsWith("/>");
}

export function findClosingTagEnd(
  textLower: string,
  startIndex: number,
  tagNameLower: string
): { start: number; end: number } | null {
  let depth = 1;
  let index = startIndex;
  while (true) {
    const lt = textLower.indexOf("<", index);
    if (lt === -1) {
      return null;
    }

    const cdataNextIndex = getCdataSectionNextIndex(textLower, lt);
    if (cdataNextIndex == null) {
      return null;
    }
    if (cdataNextIndex !== lt) {
      index = cdataNextIndex;
      continue;
    }

    const header = parseMatchingTagHeader(textLower, lt, tagNameLower);
    if (!header) {
      index = lt + 1;
      continue;
    }

    const gt = textLower.indexOf(">", header.afterName);
    if (gt === -1) {
      return null;
    }

    if (header.isClosing) {
      depth -= 1;
      if (depth === 0) {
        return { start: lt, end: gt + 1 };
      }
      index = gt + 1;
      continue;
    }

    const isSelfClosing = isSelfClosingXmlTag(textLower, lt, gt);
    if (!isSelfClosing) {
      depth += 1;
    }
    index = gt + 1;
  }
}

function findClosingTagStartWithBoundary(
  lowerText: string,
  valueStart: number,
  tagNameLower: string,
  allowEndOfStringBoundary: boolean
): number {
  const needle = `</${tagNameLower}`;
  let searchIndex = valueStart;

  while (searchIndex < lowerText.length) {
    const found = lowerText.indexOf(needle, searchIndex);
    if (found === -1) {
      return -1;
    }
    const nextChar = lowerText[found + needle.length] ?? "";
    if (nextChar === "" && !allowEndOfStringBoundary) {
      searchIndex = found + needle.length;
      continue;
    }
    if (isTagBoundaryChar(nextChar)) {
      return found;
    }
    searchIndex = found + needle.length;
  }

  return -1;
}

export function toSupportedCallEndTagName(
  tagNameLower: string | null | undefined
): string | null {
  const normalized = tagNameLower?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  return QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES.has(normalized)
    ? normalized
    : null;
}

// vLLM reference (Qwen3CoderToolParser): tolerate missing </parameter> by treating
// the next <parameter=...> / </function> boundary as an implicit close.
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L65-L68
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L612-L636
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L686-L764
function indexOfTagOpenWithBoundary(
  lowerText: string,
  fromIndex: number,
  tagNameLower: string
): number {
  const needle = `<${tagNameLower}`;
  let from = fromIndex;
  while (true) {
    const index = lowerText.indexOf(needle, from);
    if (index === -1) {
      return -1;
    }
    if (isTagNameBoundaryChar(lowerText[index + needle.length])) {
      return index;
    }
    from = index + 1;
  }
}

export function findUnclosedParamBoundaryIndex(
  lowerText: string,
  valueStart: number,
  callEndTagNameLower: string | null,
  allowEndOfString: boolean,
  schemaParamNames?: Map<string, string> | null
): number | null {
  const normalizedCallEndTag = toSupportedCallEndTagName(callEndTagNameLower);
  const callCloseIndex = normalizedCallEndTag
    ? findClosingTagStartWithBoundary(
        lowerText,
        valueStart,
        normalizedCallEndTag,
        allowEndOfString
      )
    : findClosingTagStartWithBoundary(
        lowerText,
        valueStart,
        "function",
        allowEndOfString
      );

  const indices = [
    indexOfTagOpenWithBoundary(lowerText, valueStart, "parameter"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "param"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "argument"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "arg"),
    callCloseIndex,
    findClosingTagStartWithBoundary(
      lowerText,
      valueStart,
      "tool_call",
      allowEndOfString
    ),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "function"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "call"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "tool"),
    indexOfTagOpenWithBoundary(lowerText, valueStart, "invoke"),
  ].filter((index) => index !== -1);

  if (schemaParamNames) {
    for (const nameLower of schemaParamNames.keys()) {
      const index = indexOfTagOpenWithBoundary(
        lowerText,
        valueStart,
        nameLower
      );
      if (index !== -1) {
        indices.push(index);
      }
    }
  }

  if (indices.length === 0) {
    return null;
  }
  return Math.min(...indices);
}

type Qwen3CoderToolParserParamTagParseResult =
  | {
      kind: "match";
      start: number;
      end: number;
      name: string;
      value: string;
    }
  | {
      kind: "partial";
      start: number;
      openEnd: number | null;
      name?: string;
      value?: string;
    }
  | {
      kind: "skip";
      start: number;
      end: number;
    };

function parseQwen3CoderToolParserParamTagNameLower(
  lowerText: string,
  startIndex: number,
  schemaParamNames?: Map<string, string> | null
):
  | { kind: "match"; tagNameLower: string; isSchemaParam: boolean }
  | { kind: "partial" }
  | null {
  let i = skipAsciiWhitespace(lowerText, startIndex + 1);
  if (i >= lowerText.length) {
    return { kind: "partial" };
  }
  if (lowerText[i] === "/") {
    return null;
  }

  const nameStart = i;
  while (i < lowerText.length) {
    const ch = lowerText[i] ?? "";
    if (isAsciiWhitespace(ch) || ch === ">" || ch === "/" || ch === "=") {
      break;
    }
    i += 1;
  }

  const tagNameLower = lowerText.slice(nameStart, i);
  if (QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES.has(tagNameLower)) {
    return { kind: "match", tagNameLower, isSchemaParam: false };
  }
  if (schemaParamNames?.has(tagNameLower)) {
    return { kind: "match", tagNameLower, isSchemaParam: true };
  }
  return null;
}

function parseQwen3CoderToolParserUnclosedParamValue(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  paramName: string;
  allowEndOfString: boolean;
  callEndTagNameLower?: string | null;
  schemaParamNames?: Map<string, string> | null;
}): Qwen3CoderToolParserParamTagParseResult {
  const valueStart = options.openEnd + 1;
  const boundaryIndex = findUnclosedParamBoundaryIndex(
    options.lowerText,
    valueStart,
    options.callEndTagNameLower ?? null,
    options.allowEndOfString,
    options.schemaParamNames
  );
  if (boundaryIndex == null) {
    if (!options.allowEndOfString) {
      const rawProgressValue = options.text.slice(valueStart);
      return {
        kind: "partial",
        start: options.startIndex,
        openEnd: options.openEnd,
        name: options.paramName,
        value: rawProgressValue ? normalizeXmlTextValue(rawProgressValue) : "",
      };
    }

    const rawValue = options.text.slice(valueStart);
    return {
      kind: "match",
      start: options.startIndex,
      end: options.text.length,
      name: options.paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  const rawValue = options.text.slice(valueStart, boundaryIndex);
  return {
    kind: "match",
    start: options.startIndex,
    end: boundaryIndex,
    name: options.paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}

function parseQwen3CoderToolParserSchemaParamTag(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  tagNameLower: string;
  paramName: string;
  selfClosing: boolean;
  allowEndOfString: boolean;
  callEndTagNameLower?: string | null;
  schemaParamNames?: Map<string, string> | null;
}): Qwen3CoderToolParserParamTagParseResult {
  const { text, lowerText, startIndex, openEnd, tagNameLower, paramName } =
    options;

  if (options.selfClosing) {
    return {
      kind: "match",
      start: startIndex,
      end: openEnd + 1,
      name: paramName,
      value: "",
    };
  }

  const valueStart = openEnd + 1;
  const close = findClosingTagEnd(lowerText, valueStart, tagNameLower);
  if (close) {
    const rawValue = text.slice(valueStart, close.start);
    return {
      kind: "match",
      start: startIndex,
      end: close.end,
      name: paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  return parseQwen3CoderToolParserUnclosedParamValue({
    text,
    lowerText,
    startIndex,
    openEnd,
    paramName,
    allowEndOfString: options.allowEndOfString,
    callEndTagNameLower: options.callEndTagNameLower,
    schemaParamNames: options.schemaParamNames,
  });
}

export function parseQwen3CoderToolParserParamTagAt(
  text: string,
  lowerText: string,
  startIndex: number,
  options?: {
    allowEndOfString?: boolean;
    callEndTagNameLower?: string | null;
    schemaParamNames?: Map<string, string> | null;
  }
): Qwen3CoderToolParserParamTagParseResult | null {
  const tagNameParse = parseQwen3CoderToolParserParamTagNameLower(
    lowerText,
    startIndex,
    options?.schemaParamNames
  );
  if (!tagNameParse) {
    return null;
  }
  if (tagNameParse.kind === "partial") {
    return { kind: "partial", start: startIndex, openEnd: null };
  }

  const { tagNameLower } = tagNameParse;

  const openEnd = findTagEndIndex(text, startIndex);
  if (openEnd == null) {
    return { kind: "partial", start: startIndex, openEnd: null };
  }

  const openTag = text.slice(startIndex, openEnd + 1);

  if (tagNameParse.isSchemaParam) {
    return parseQwen3CoderToolParserSchemaParamTag({
      text,
      lowerText,
      startIndex,
      openEnd,
      tagNameLower,
      paramName: options?.schemaParamNames?.get(tagNameLower) ?? tagNameLower,
      selfClosing: openTag.trimEnd().endsWith("/>"),
      allowEndOfString: options?.allowEndOfString === true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
  }
  const paramNameRaw = parseQwen3CoderToolParserParamName(
    openTag,
    tagNameLower
  );
  const paramName = paramNameRaw?.trim() ?? "";
  const selfClosing = openTag.trimEnd().endsWith("/>");
  if (selfClosing && paramName.length === 0) {
    return {
      kind: "skip",
      start: startIndex,
      end: openEnd + 1,
    };
  }
  if (paramName.length === 0) {
    return parseQwen3CoderNamelessParamTag({
      text,
      lowerText,
      startIndex,
      openEnd,
      tagNameLower,
      allowEndOfString: options?.allowEndOfString === true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
  }

  if (selfClosing) {
    return {
      kind: "match",
      start: startIndex,
      end: openEnd + 1,
      name: paramName,
      value: "",
    };
  }

  const valueStart = openEnd + 1;
  const close = findClosingTagEnd(lowerText, valueStart, tagNameLower);
  if (!close) {
    return parseQwen3CoderToolParserUnclosedParamValue({
      text,
      lowerText,
      startIndex,
      openEnd,
      paramName,
      allowEndOfString: options?.allowEndOfString === true,
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
    });
  }

  const rawValue = text.slice(openEnd + 1, close.start);
  return {
    kind: "match",
    start: startIndex,
    end: close.end,
    name: paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}

const VALUE_ELEMENT_WRAPPER_RE = /^<value\s*>([\s\S]*)<\/value\s*>$/i;

export function normalizeXmlTextValue(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("<![CDATA[") && out.endsWith("]]>")) {
    out = out.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  // Some models wrap the value in a literal <value> element
  // (`<parameter=volume><value>0.8</value></parameter>`, observed live on
  // Llama 3.1 8B); unwrap exactly that shape.
  const valueWrapper = VALUE_ELEMENT_WRAPPER_RE.exec(out);
  if (valueWrapper) {
    out = (valueWrapper[1] ?? "").trim();
  }
  return unescapeXml(out);
}

const NAMELESS_PARAM_IDENTIFIER_RE = /^[A-Za-z_][\w.-]{0,255}$/;
const redundantNamelessParamCloseTagCache = new Map<string, RegExp>();

function stripRedundantNamelessParamValueClose(options: {
  rawValue: string;
  paramName: string;
  tagNameLower: string;
  schemaParamNames?: Map<string, string> | null;
}): string {
  if (!options.schemaParamNames?.has(options.paramName.toLowerCase())) {
    return options.rawValue;
  }

  let closeAtEnd = redundantNamelessParamCloseTagCache.get(
    options.tagNameLower
  );
  if (!closeAtEnd) {
    closeAtEnd = new RegExp(
      `<\\s*\\/\\s*${escapeRegExp(options.tagNameLower)}\\s*>\\s*$`,
      "i"
    );
    redundantNamelessParamCloseTagCache.set(options.tagNameLower, closeAtEnd);
  }

  const match = closeAtEnd.exec(options.rawValue);
  if (!match || match.index === undefined) {
    return options.rawValue;
  }
  return options.rawValue.slice(0, match.index);
}

function isSchemaBackedNamelessParam(
  paramName: string,
  schemaParamNames?: Map<string, string> | null
): boolean {
  return schemaParamNames?.has(paramName.toLowerCase()) === true;
}

/**
 * Salvage the nameless-tag variant some models (e.g. Qwen2.5) emit when they
 * half-follow the format:
 *
 *   <parameter>city</parameter>
 *   Seoul
 *
 * The element text is the parameter NAME and the plain text after the closing
 * tag (up to the next parameter tag or call close boundary) is the VALUE.
 * Only identifier-like element text qualifies, so ordinary tagged content is
 * not misread as a parameter.
 */
function parseQwen3CoderNamelessParamTag(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  tagNameLower: string;
  allowEndOfString: boolean;
  callEndTagNameLower?: string | null;
  schemaParamNames?: Map<string, string> | null;
}): Qwen3CoderToolParserParamTagParseResult | null {
  const { text, lowerText, startIndex, openEnd, tagNameLower } = options;

  const nameStart = openEnd + 1;
  const close = findClosingTagEnd(lowerText, nameStart, tagNameLower);
  if (!close) {
    // The closing tag may still be streaming in.
    return options.allowEndOfString
      ? null
      : { kind: "partial", start: startIndex, openEnd };
  }

  const paramName = normalizeXmlTextValue(text.slice(nameStart, close.start));
  if (!NAMELESS_PARAM_IDENTIFIER_RE.test(paramName)) {
    return null;
  }

  const valueStart = close.end;
  const boundaryIndex = findUnclosedParamBoundaryIndex(
    lowerText,
    valueStart,
    options.callEndTagNameLower ?? null,
    options.allowEndOfString,
    options.schemaParamNames
  );
  if (boundaryIndex == null) {
    if (!options.allowEndOfString) {
      const rawProgressValue = stripRedundantNamelessParamValueClose({
        rawValue: text.slice(valueStart),
        paramName,
        tagNameLower,
        schemaParamNames: options.schemaParamNames,
      });
      return {
        kind: "partial",
        start: startIndex,
        openEnd,
        // Schema coercion can rewrite an incomplete nameless value (notably a
        // JSON array or number), so only previously completed parameters are
        // safe to stream. The current value is emitted once its boundary is
        // known. Schema-less legacy salvage keeps its historical progress.
        ...(isSchemaBackedNamelessParam(paramName, options.schemaParamNames)
          ? {}
          : {
              name: paramName,
              value: rawProgressValue
                ? normalizeXmlTextValue(rawProgressValue)
                : "",
            }),
      };
    }

    const rawValue = stripRedundantNamelessParamValueClose({
      rawValue: text.slice(valueStart),
      paramName,
      tagNameLower,
      schemaParamNames: options.schemaParamNames,
    });
    return {
      kind: "match",
      start: startIndex,
      end: text.length,
      name: paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  const rawValue = stripRedundantNamelessParamValueClose({
    rawValue: text.slice(valueStart, boundaryIndex),
    paramName,
    tagNameLower,
    schemaParamNames: options.schemaParamNames,
  });
  return {
    kind: "match",
    start: startIndex,
    end: boundaryIndex,
    name: paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}

export function getOpeningTag(xml: string): string | null {
  const gt = xml.indexOf(">");
  if (gt === -1) {
    return null;
  }
  return xml.slice(0, gt + 1);
}

const attrValueRegExpCache = new Map<string, RegExp>();

export function getAttributeValue(
  openTag: string,
  attrName: string
): string | null {
  let re = attrValueRegExpCache.get(attrName);
  if (!re) {
    // Since the regex has no 'g' flag, re.exec resets automatically — safe.
    re = new RegExp(
      `(?:^|[\\s<])${escapeRegExp(attrName)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
      "i"
    );
    attrValueRegExpCache.set(attrName, re);
  }
  const match = re.exec(openTag);
  if (!match) {
    return null;
  }
  return unescapeXml(match[2] ?? "").trim();
}

export function getShorthandValue(openTag: string): string | null {
  const match = CALL_SHORTHAND_VALUE_RE.exec(openTag);
  if (!match) {
    return null;
  }
  const value = match[2] ?? match[3] ?? match[4];
  if (!value) {
    return null;
  }
  const normalized = unescapeXml(value).trim();
  return normalized.length > 0 ? normalized : null;
}
