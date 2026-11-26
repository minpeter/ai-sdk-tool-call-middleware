import { escapeRegExp } from "../../../shared/regex";
import { unescapeXml } from "../../../shared/xml-escape";
import {
  CALL_SHORTHAND_VALUE_RE,
  isAsciiWhitespace,
  isTagBoundaryChar,
  isTagNameBoundaryChar,
  QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES,
  skipAsciiWhitespace,
} from "./call-syntax";

const VALUE_ELEMENT_WRAPPER_RE = /^<value\s*>([\s\S]*)<\/value\s*>$/i;
const attrValueRegExpCache = new Map<string, RegExp>();

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

export function normalizeXmlTextValue(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("<![CDATA[") && out.endsWith("]]>")) {
    out = out.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  const valueWrapper = VALUE_ELEMENT_WRAPPER_RE.exec(out);
  if (valueWrapper) {
    out = (valueWrapper[1] ?? "").trim();
  }
  return unescapeXml(out);
}

export function getOpeningTag(xml: string): string | null {
  const gt = xml.indexOf(">");
  if (gt === -1) {
    return null;
  }
  return xml.slice(0, gt + 1);
}

export function getAttributeValue(
  openTag: string,
  attrName: string
): string | null {
  let re = attrValueRegExpCache.get(attrName);
  if (!re) {
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
