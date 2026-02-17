import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import {
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
  unescapeXml,
} from "../../rxml/utils/helpers";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateToolCallId } from "../utils/id";
import { createFlushTextHandler } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import {
  emitFinalRemainder,
  emitPrefixDelta,
  toIncompleteJsonPrefix,
} from "../utils/streamed-tool-input-delta";
import { coerceToolCallInput } from "../utils/tool-call-coercion";
import type { ParserOptions, TCMProtocol } from "./protocol-interface";

function shouldEmitRawToolCallTextOnError(options?: ParserOptions): boolean {
  return options?.emitRawToolCallTextOnError === true;
}

const TOOL_CALL_OPEN_RE = /<tool_call\b[^>]*>/i;
const TOOL_CALL_CLOSE_RE = /<\/tool_call\s*>/i;
const TOOL_CALL_CLOSE_TRAILING_RE = /<\/tool_call\s*>\s*$/i;
const TOOL_CALL_BLOCK_RE = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi;
const LEADING_CALL_CLOSE_TAG_RE =
  /^\s*<\s*\/\s*(?:tool_call|function|call|tool|invoke)\s*>/i;

const CALL_BLOCK_RE = /<(call|function|tool|invoke)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES = new Set([
  "parameter",
  "param",
  "argument",
  "arg",
]);

const CALL_SHORTHAND_VALUE_RE =
  /^<\s*(call|function|tool|invoke)\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/]+))/i;

// Non-global variants for streaming parsing (avoids `lastIndex` state).
const QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b/i;
const QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b[^>]*>/i;
const QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE =
  /<\s*\/\s*tool_call\s*>/i;
const QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE =
  /<\s*(?!\/)\s*(name|tool_name|parameter|param|argument|arg)\b/i;
const QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE =
  /<\s*(name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/i;
const QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE = /\/\s*>$/;

function isAsciiWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f";
}

function skipAsciiWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isAsciiWhitespace(text[i] ?? "")) {
    i += 1;
  }
  return i;
}

function stripLeadingToolCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const start = skipAsciiWhitespace(out, 0);
    const trimmed = out.slice(start);
    const match = TOOL_CALL_CLOSE_RE.exec(trimmed);
    if (!match || match.index !== 0 || !match[0]) {
      return out;
    }
    out = out.slice(start + match[0].length);
  }
}

function stripTrailingToolCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const next = out.replace(TOOL_CALL_CLOSE_TRAILING_RE, "");
    if (next === out) {
      return out;
    }
    out = next;
  }
}

function isTagBoundaryChar(ch: string): boolean {
  return ch === "" || isAsciiWhitespace(ch) || ch === ">" || ch === "/";
}

function findTagEndIndex(text: string, startIndex: number): number | null {
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

function parseShorthandValue(
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

function findClosingTagEnd(
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

// vLLM reference (Qwen3CoderToolParser): tolerate missing </parameter> by treating
// the next <parameter=...> / </function> boundary as an implicit close.
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L65-L68
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L612-L636
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L686-L764
function findUnclosedParamBoundaryIndex(
  lowerText: string,
  valueStart: number
): number | null {
  const indices = [
    lowerText.indexOf("<parameter", valueStart),
    lowerText.indexOf("<param", valueStart),
    lowerText.indexOf("<argument", valueStart),
    lowerText.indexOf("<arg", valueStart),
    lowerText.indexOf("</function", valueStart),
    lowerText.indexOf("</tool_call", valueStart),
    lowerText.indexOf("<function", valueStart),
  ].filter((index) => index !== -1);

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
    };

function parseQwen3CoderToolParserParamTagNameLower(
  lowerText: string,
  startIndex: number
): { kind: "match"; tagNameLower: string } | { kind: "partial" } | null {
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
  if (!QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES.has(tagNameLower)) {
    return null;
  }
  return { kind: "match", tagNameLower };
}

function parseQwen3CoderToolParserUnclosedParamValue(options: {
  text: string;
  lowerText: string;
  startIndex: number;
  openEnd: number;
  paramName: string;
  allowEndOfString: boolean;
}): Qwen3CoderToolParserParamTagParseResult {
  const valueStart = options.openEnd + 1;
  const boundaryIndex = findUnclosedParamBoundaryIndex(
    options.lowerText,
    valueStart
  );
  if (boundaryIndex == null) {
    if (!options.allowEndOfString) {
      return {
        kind: "partial",
        start: options.startIndex,
        openEnd: options.openEnd,
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

function parseQwen3CoderToolParserParamTagAt(
  text: string,
  lowerText: string,
  startIndex: number,
  options?: {
    allowEndOfString?: boolean;
  }
): Qwen3CoderToolParserParamTagParseResult | null {
  const tagNameParse = parseQwen3CoderToolParserParamTagNameLower(
    lowerText,
    startIndex
  );
  if (!tagNameParse) {
    return null;
  }
  if (tagNameParse.kind === "partial") {
    return { kind: "partial", start: startIndex, openEnd: null };
  }

  const tagNameLower = tagNameParse.tagNameLower;

  const openEnd = findTagEndIndex(text, startIndex);
  if (openEnd == null) {
    return { kind: "partial", start: startIndex, openEnd: null };
  }

  const openTag = text.slice(startIndex, openEnd + 1);
  const paramNameRaw = parseQwen3CoderToolParserParamName(
    openTag,
    tagNameLower
  );
  const paramName = paramNameRaw?.trim() ?? "";
  if (paramName.length === 0) {
    return null;
  }

  const selfClosing = openTag.trimEnd().endsWith("/>");
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

function normalizeXmlTextValue(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("<![CDATA[") && out.endsWith("]]>")) {
    out = out.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  return unescapeXml(out);
}

function getOpeningTag(xml: string): string | null {
  const gt = xml.indexOf(">");
  if (gt === -1) {
    return null;
  }
  return xml.slice(0, gt + 1);
}

const attrValueRegExpCache = new Map<string, RegExp>();

function getAttributeValue(openTag: string, attrName: string): string | null {
  let re = attrValueRegExpCache.get(attrName);
  if (!re) {
    // Since the regex has no 'g' flag, re.exec resets automatically — safe.
    re = new RegExp(
      `\\b${escapeRegExp(attrName)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
      "i"
    );
    attrValueRegExpCache.set(attrName, re);
  }
  const match = re.exec(openTag);
  if (!match) {
    return null;
  }
  return unescapeXml(match[2] ?? "");
}

function getShorthandValue(openTag: string): string | null {
  const match = CALL_SHORTHAND_VALUE_RE.exec(openTag);
  if (!match) {
    return null;
  }
  const value = match[2] ?? match[3] ?? match[4];
  if (!value) {
    return null;
  }
  return unescapeXml(value);
}

function extractFirstTagText(xml: string, tagName: string): string | null {
  const lower = xml.toLowerCase();
  const tagLower = tagName.toLowerCase();

  let index = 0;
  while (true) {
    const lt = lower.indexOf("<", index);
    if (lt === -1) {
      return null;
    }

    const i = skipAsciiWhitespace(lower, lt + 1);
    if (i >= lower.length || lower[i] === "/") {
      index = lt + 1;
      continue;
    }

    if (!lower.startsWith(tagLower, i)) {
      index = lt + 1;
      continue;
    }

    const afterName = i + tagLower.length;
    const boundary = lower[afterName] ?? "";
    if (boundary && !isTagBoundaryChar(boundary)) {
      index = lt + 1;
      continue;
    }

    const openEnd = findTagEndIndex(xml, lt);
    if (openEnd == null) {
      return null;
    }
    const contentStart = openEnd + 1;
    const close = findClosingTagEnd(lower, contentStart, tagLower);
    if (!close) {
      return null;
    }
    return normalizeXmlTextValue(xml.slice(contentStart, close.start));
  }
}

function extractToolCallInnerXml(segment: string): {
  inner: string;
  outerOpenTag: string;
} | null {
  const openMatch = TOOL_CALL_OPEN_RE.exec(segment);
  const closeMatch = TOOL_CALL_CLOSE_RE.exec(segment);
  if (!(openMatch && closeMatch)) {
    return null;
  }

  const openIndex = openMatch.index;
  const openTag = openMatch[0];
  const openEnd = openIndex + openTag.length;

  // Prefer the last closing tag to avoid early matches if nested content
  // includes a literal "</tool_call>" string.
  const closeIndex = segment.toLowerCase().lastIndexOf("</tool_call");
  if (closeIndex === -1) {
    return null;
  }
  const closeGt = segment.indexOf(">", closeIndex);
  if (closeGt === -1) {
    return null;
  }

  return {
    outerOpenTag: openTag,
    inner: segment.slice(openEnd, closeIndex),
  };
}

function mergeParamValue(
  args: Record<string, unknown>,
  key: string,
  value: string
): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  args[key] = [existing, value];
}

function extractParameters(xml: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  const lower = xml.toLowerCase();
  let index = 0;
  while (true) {
    const lt = lower.indexOf("<", index);
    if (lt === -1) {
      break;
    }
    const parsed = parseQwen3CoderToolParserParamTagAt(xml, lower, lt, {
      allowEndOfString: true,
    });
    if (!parsed) {
      index = lt + 1;
      continue;
    }

    if (parsed.kind === "match") {
      mergeParamValue(args, parsed.name, parsed.value);
      index = parsed.end;
      continue;
    }

    index = (parsed.openEnd ?? lt) + 1;
  }

  return args;
}

function parseSingleFunctionCallXml(
  xml: string,
  fallbackToolName: string | null
): { toolName: string; args: Record<string, unknown> } | null {
  const openingTag = getOpeningTag(xml);
  const toolNameAttr = openingTag
    ? getAttributeValue(openingTag, "name")
    : null;
  const shorthandName = openingTag ? getShorthandValue(openingTag) : null;
  const toolName =
    toolNameAttr ??
    shorthandName ??
    extractFirstTagText(xml, "name") ??
    extractFirstTagText(xml, "tool_name") ??
    fallbackToolName;

  if (!toolName || toolName.trim().length === 0) {
    return null;
  }

  return {
    toolName,
    args: extractParameters(xml),
  };
}

function findImplicitCallOpenIndices(lowerText: string): number[] {
  const indices: number[] = [];
  let index = 0;
  while (true) {
    const lt = lowerText.indexOf("<", index);
    if (lt === -1) {
      break;
    }

    const i = skipAsciiWhitespace(lowerText, lt + 1);
    if (i >= lowerText.length) {
      break;
    }
    if (lowerText[i] === "/") {
      index = lt + 1;
      continue;
    }

    const tagNames = ["call", "function", "tool", "invoke"] as const;
    for (const tagName of tagNames) {
      if (!lowerText.startsWith(tagName, i)) {
        continue;
      }
      const after = i + tagName.length;
      const boundary = lowerText[after] ?? "";
      if (boundary && !isTagBoundaryChar(boundary) && boundary !== "=") {
        continue;
      }
      indices.push(lt);
      break;
    }

    index = lt + 1;
  }
  return indices;
}

function splitImplicitCallBlocks(xml: string): string[] {
  const lower = xml.toLowerCase();
  const starts = findImplicitCallOpenIndices(lower);
  if (starts.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? 0;
    const end = starts[i + 1] ?? xml.length;
    blocks.push(xml.slice(start, end));
  }
  return blocks;
}

function stripLeadingCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const match = LEADING_CALL_CLOSE_TAG_RE.exec(out);
    if (!match) {
      return out;
    }
    out = out.slice(match[0].length);
  }
}

function getOpenTagNameLower(openTag: string): string | null {
  const lowerOpenTag = openTag.toLowerCase();
  const lt = lowerOpenTag.indexOf("<");
  if (lt === -1) {
    return null;
  }

  let i = skipAsciiWhitespace(lowerOpenTag, lt + 1);
  if (i >= lowerOpenTag.length || lowerOpenTag[i] === "/") {
    return null;
  }

  const start = i;
  while (i < lowerOpenTag.length) {
    const ch = lowerOpenTag[i] ?? "";
    if (isAsciiWhitespace(ch) || ch === ">" || ch === "/" || ch === "=") {
      break;
    }
    i += 1;
  }

  const tagName = lowerOpenTag.slice(start, i);
  return tagName.length > 0 ? tagName : null;
}

function splitImplicitCallAndTail(callBlock: string): {
  callContent: string;
  trailingText: string;
} {
  const openingTag = getOpeningTag(callBlock);
  const lowerCallBlock = callBlock.toLowerCase();
  let consumed = 0;

  if (openingTag) {
    consumed = openingTag.length;
    const openingTagName = getOpenTagNameLower(openingTag);
    if (openingTagName) {
      const close = findClosingTagEnd(lowerCallBlock, consumed, openingTagName);
      if (close) {
        consumed = Math.max(consumed, close.end);
      }
    }
  }

  let index = 0;
  while (true) {
    const lt = lowerCallBlock.indexOf("<", index);
    if (lt === -1) {
      break;
    }

    const parsed = parseQwen3CoderToolParserParamTagAt(
      callBlock,
      lowerCallBlock,
      lt,
      {
        allowEndOfString: true,
      }
    );
    if (!parsed) {
      index = lt + 1;
      continue;
    }

    if (parsed.kind === "partial") {
      index = (parsed.openEnd ?? lt) + 1;
      continue;
    }

    consumed = Math.max(consumed, parsed.end);
    index = parsed.end;
  }

  const clamped = Math.max(0, Math.min(consumed, callBlock.length));
  return {
    callContent: callBlock.slice(0, clamped),
    trailingText: callBlock.slice(clamped),
  };
}

function parseQwen3CoderToolParserCallBlocks(
  blocks: string[],
  outerNameAttr: string | null
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  for (const block of blocks) {
    const parsed = parseSingleFunctionCallXml(block, outerNameAttr);
    if (!parsed) {
      return null;
    }
    calls.push(parsed);
  }
  return calls;
}

function parseQwen3CoderToolParserClosedMatches(
  inner: string,
  outerNameAttr: string | null
):
  | Array<{ toolName: string; args: Record<string, unknown> }>
  | null
  | undefined {
  const callBlockMatches = Array.from(inner.matchAll(CALL_BLOCK_RE));
  if (callBlockMatches.length === 0) {
    return undefined;
  }

  const closedBlocks: string[] = [];
  let lastClosedEnd = 0;
  for (const match of callBlockMatches) {
    const callBlock = match[0] ?? "";
    const startIndex = match.index ?? -1;
    if (!callBlock || startIndex < 0) {
      continue;
    }
    closedBlocks.push(callBlock);
    lastClosedEnd = startIndex + callBlock.length;
  }

  const closedCalls = parseQwen3CoderToolParserCallBlocks(
    closedBlocks,
    outerNameAttr
  );
  if (!closedCalls) {
    return null;
  }

  const trailingInner = inner.slice(lastClosedEnd);
  if (trailingInner.trim().length === 0) {
    return closedCalls;
  }

  const trailingBlocks = splitImplicitCallBlocks(trailingInner).filter(
    (b) => b.trim().length > 0
  );
  const blocksToParse =
    trailingBlocks.length > 0 ? trailingBlocks : [trailingInner];
  const trailingCalls = parseQwen3CoderToolParserCallBlocks(
    blocksToParse,
    outerNameAttr
  );
  if (!trailingCalls) {
    return null;
  }

  return closedCalls.concat(trailingCalls);
}

function parseQwen3CoderToolParserToolCallSegment(
  segment: string
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const extracted = extractToolCallInnerXml(segment);
  if (!extracted) {
    return null;
  }

  const { inner, outerOpenTag } = extracted;
  const outerNameAttr = getAttributeValue(outerOpenTag, "name");

  const closedCalls = parseQwen3CoderToolParserClosedMatches(
    inner,
    outerNameAttr
  );
  if (closedCalls) {
    return closedCalls;
  }
  if (closedCalls === null) {
    return null;
  }

  // Some models omit the closing </function> and go straight to </tool_call>.
  // When that happens, CALL_BLOCK_RE matches nothing; fall back to splitting
  // by call-opening tags (<function=...>, etc.) and treating the next opening
  // tag or end-of-container as an implicit terminator.
  const implicitBlocks = splitImplicitCallBlocks(inner).filter(
    (b) => b.trim().length > 0
  );
  if (implicitBlocks.length > 0) {
    return parseQwen3CoderToolParserCallBlocks(implicitBlocks, outerNameAttr);
  }

  const single =
    parseSingleFunctionCallXml(inner, outerNameAttr) ??
    parseSingleFunctionCallXml(segment, outerNameAttr);
  if (!single) {
    return null;
  }
  return [single];
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

function parseToolCallInput(input: string | null | undefined): unknown {
  if (input == null) {
    return {};
  }
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

// vLLM reference (Qwen3CoderToolParser): converts string parameters to typed JSON
// values using the tool schema (int/float/bool/object/array, with json.loads and
// ast.literal_eval fallback).
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L136-L240
// https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L379-L430
function stringifyToolInputWithSchema(options: {
  tools: LanguageModelV3FunctionTool[];
  toolName: string;
  args: Record<string, unknown>;
}): string {
  const coerced = coerceToolCallInput(
    options.toolName,
    options.args,
    options.tools
  );
  return coerced ?? JSON.stringify(options.args);
}

function toQwen3CoderToolParserParamText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function appendQwen3CoderToolParserParameter(
  lines: string[],
  key: string,
  value: unknown
): void {
  const nameAttr = escapeXmlMinimalAttr(key, '"');
  const text = escapeXmlMinimalText(toQwen3CoderToolParserParamText(value));
  lines.push(`    <parameter=${nameAttr}>${text}</parameter>`);
}

function appendQwen3CoderToolParserArgs(lines: string[], args: unknown): void {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          appendQwen3CoderToolParserParameter(lines, key, item);
        }
      } else {
        appendQwen3CoderToolParserParameter(lines, key, value);
      }
    }
    return;
  }

  if (args !== undefined && args !== null && args !== "") {
    appendQwen3CoderToolParserParameter(lines, "input", args);
  }
}

export const qwen3CoderProtocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return toolSystemPromptTemplate(tools || []);
  },

  formatToolCall(toolCall: LanguageModelV3ToolCall): string {
    const args = parseToolCallInput(toolCall.input);
    const lines: string[] = ["<tool_call>"];
    lines.push(`  <function=${escapeXmlMinimalAttr(toolCall.toolName, '"')}>`);
    appendQwen3CoderToolParserArgs(lines, args);
    lines.push("  </function>");
    lines.push("</tool_call>");
    return lines.join("\n");
  },

  parseGeneratedText({ text, tools, options }) {
    const processedElements: LanguageModelV3Content[] = [];

    const emitToolCalls = (
      calls: Array<{ toolName: string; args: Record<string, unknown> }>
    ) => {
      for (const call of calls) {
        processedElements.push({
          type: "tool-call",
          toolCallId: generateToolCallId(),
          toolName: call.toolName,
          input: stringifyToolInputWithSchema({
            tools,
            toolName: call.toolName,
            args: call.args,
          }),
        });
      }
    };

    const pushText = (value: string) => {
      if (value.length === 0) {
        return;
      }
      processedElements.push({ type: "text", text: value });
    };

    const tryEmitToolCallSegment = (
      segment: string,
      fallbackText: string = segment
    ): boolean => {
      const parsedCalls = parseQwen3CoderToolParserToolCallSegment(segment);
      if (!parsedCalls) {
        options?.onError?.(
          "Could not process Qwen3CoderToolParser XML tool call; keeping original text.",
          { toolCall: fallbackText }
        );
        processedElements.push({ type: "text", text: fallbackText });
        return false;
      }
      emitToolCalls(parsedCalls);
      return true;
    };

    const emitWrapperlessCallParseFailureAsText = (raw: string) => {
      options?.onError?.(
        "Could not process Qwen3CoderToolParser <function> call; keeping original text.",
        { toolCall: raw }
      );
      processedElements.push({ type: "text", text: raw });
    };

    const tryParseCallBlocksWithoutWrapperByImplicitStarts = (
      sourceText: string,
      starts: number[]
    ): boolean => {
      let index = 0;
      for (let i = 0; i < starts.length; i += 1) {
        const startIndex = starts[i] ?? -1;
        if (startIndex < 0) {
          continue;
        }
        const endIndex = starts[i + 1] ?? sourceText.length;

        pushText(
          stripTrailingToolCallCloseTags(
            stripLeadingToolCallCloseTags(sourceText.slice(index, startIndex))
          )
        );

        const full = sourceText.slice(startIndex, endIndex);
        const { callContent, trailingText } = splitImplicitCallAndTail(full);
        const parsed = parseSingleFunctionCallXml(callContent, null);
        if (parsed) {
          emitToolCalls([parsed]);
          pushText(
            stripTrailingToolCallCloseTags(
              stripLeadingToolCallCloseTags(trailingText)
            )
          );
        } else {
          emitWrapperlessCallParseFailureAsText(full);
        }

        index = endIndex;
      }

      pushText(
        stripTrailingToolCallCloseTags(
          stripLeadingToolCallCloseTags(sourceText.slice(index))
        )
      );
      return true;
    };

    const tryParseCallBlocksWithoutWrapperByMatches = (
      sourceText: string,
      matches: RegExpMatchArray[]
    ): boolean => {
      let index = 0;
      for (const match of matches) {
        const full = match[0];
        const startIndex = match.index ?? -1;
        if (!full || startIndex < 0) {
          continue;
        }

        pushText(
          stripTrailingToolCallCloseTags(
            stripLeadingToolCallCloseTags(sourceText.slice(index, startIndex))
          )
        );

        const parsed = parseSingleFunctionCallXml(full, null);
        if (parsed) {
          emitToolCalls([parsed]);
        } else {
          emitWrapperlessCallParseFailureAsText(full);
        }
        index = startIndex + full.length;
      }

      const trailing = sourceText.slice(index);
      const trailingStarts = findImplicitCallOpenIndices(
        trailing.toLowerCase()
      );
      if (trailingStarts.length > 0) {
        return tryParseCallBlocksWithoutWrapperByImplicitStarts(
          trailing,
          trailingStarts
        );
      }

      pushText(
        stripTrailingToolCallCloseTags(stripLeadingToolCallCloseTags(trailing))
      );
      return true;
    };

    // vLLM reference (Qwen3CoderToolParser): fallback extraction still attempts to
    // parse when XML wrapper tags are missing (raw output starts with <function=...>).
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L271-L289
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L356-L377
    const tryParseCallBlocksWithoutWrapperText = (
      sourceText: string
    ): boolean => {
      const matches = Array.from(sourceText.matchAll(CALL_BLOCK_RE));
      if (matches.length > 0) {
        return tryParseCallBlocksWithoutWrapperByMatches(sourceText, matches);
      }

      const starts = findImplicitCallOpenIndices(sourceText.toLowerCase());
      if (starts.length === 0) {
        return false;
      }
      return tryParseCallBlocksWithoutWrapperByImplicitStarts(
        sourceText,
        starts
      );
    };

    const pushTextOrParseWrapperlessCalls = (segment: string) => {
      if (segment.length === 0) {
        return;
      }
      if (!tryParseCallBlocksWithoutWrapperText(segment)) {
        pushText(segment);
      }
    };

    // vLLM reference (Qwen3CoderToolParser): allow trailing, incomplete <tool_call>
    // blocks ("<tool_call>...$"), and still attempt best-effort parsing.
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L55-L61
    const handleCompleteToolCallRemainder = (remainder: string) => {
      if (!remainder) {
        return;
      }
      const lowerRemainder = remainder.toLowerCase();
      const trailingIndex = lowerRemainder.indexOf("<tool_call");
      if (trailingIndex === -1) {
        pushTextOrParseWrapperlessCalls(remainder);
        return;
      }

      pushTextOrParseWrapperlessCalls(remainder.slice(0, trailingIndex));
      const trailing = remainder.slice(trailingIndex);
      const synthetic = TOOL_CALL_CLOSE_RE.test(trailing)
        ? trailing
        : `${trailing}</tool_call>`;
      tryEmitToolCallSegment(synthetic, trailing);
    };

    const tryParseCompleteToolCallBlocks = (): boolean => {
      const matches = Array.from(text.matchAll(TOOL_CALL_BLOCK_RE));
      if (matches.length === 0) {
        return false;
      }

      let index = 0;
      for (const match of matches) {
        const full = match[0];
        const startIndex = match.index ?? -1;
        if (!full || startIndex < 0) {
          continue;
        }

        pushTextOrParseWrapperlessCalls(text.slice(index, startIndex));
        tryEmitToolCallSegment(full);
        index = startIndex + full.length;
      }

      handleCompleteToolCallRemainder(text.slice(index));
      return true;
    };

    const tryParseIncompleteToolCall = (): boolean => {
      const lowerText = text.toLowerCase();
      const startIndex = lowerText.indexOf("<tool_call");
      if (startIndex === -1) {
        return false;
      }

      pushTextOrParseWrapperlessCalls(text.slice(0, startIndex));
      const trailing = text.slice(startIndex);
      const synthetic = TOOL_CALL_CLOSE_RE.test(trailing)
        ? trailing
        : `${trailing}</tool_call>`;
      tryEmitToolCallSegment(synthetic, trailing);
      return true;
    };

    const tryParseCallBlocksWithoutWrapper = (): boolean => {
      return tryParseCallBlocksWithoutWrapperText(text);
    };

    const tryParseSingleFunctionCall = (): boolean => {
      const lowerText = text.toLowerCase();
      const startIndex = lowerText.indexOf("<function");
      if (startIndex === -1) {
        return false;
      }

      pushText(stripTrailingToolCallCloseTags(text.slice(0, startIndex)));
      const trailing = stripLeadingToolCallCloseTags(text.slice(startIndex));
      const parsed = parseSingleFunctionCallXml(trailing, null);
      if (!parsed) {
        processedElements.push({ type: "text", text: trailing });
        return true;
      }

      emitToolCalls([parsed]);
      return true;
    };

    if (tryParseCompleteToolCallBlocks()) {
      return processedElements;
    }
    if (tryParseIncompleteToolCall()) {
      return processedElements;
    }
    if (tryParseCallBlocksWithoutWrapper()) {
      return processedElements;
    }
    if (tryParseSingleFunctionCall()) {
      return processedElements;
    }

    return [{ type: "text", text }];
  },

  extractToolCallSegments({ text }) {
    return Array.from(text.matchAll(TOOL_CALL_BLOCK_RE))
      .map((m) => m[0])
      .filter((s): s is string => Boolean(s));
  },

  createStreamParser({ tools, options }) {
    const toolCallStartPrefixLower = "<tool_call";

    // vLLM reference (Qwen3XMLToolParser): streaming tool calls can start directly
    // with <function=...> (missing opening <tool_call>), and the parser implicitly
    // starts a tool_call container.
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3xml_tool_parser.py#L595-L642
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L901-L922
    const implicitCallPrefixesLower = [
      "<function",
      "<call",
      "<tool",
      "<invoke",
    ];

    type ToolCallMode = "unknown" | "single" | "multi";

    interface StreamingCallState {
      endTagName: string;
      toolCallId: string;
      toolName: string | null;
      hasEmittedStart: boolean;
      emittedInput: string;
      raw: string;
      args: Record<string, unknown>;
      buffer: string;
    }

    interface ToolCallContainerState {
      outerOpenTag: string;
      outerNameAttr: string | null;
      raw: string;
      mode: ToolCallMode;
      innerBuffer: string;
      activeCall: StreamingCallState | null;
      emittedToolCallCount: number;
    }

    let buffer = "";
    let toolCall: ToolCallContainerState | null = null;
    let implicitCall: StreamingCallState | null = null;
    let implicitCallOpenTag: string | null = null;
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;

    const flushText = createFlushTextHandler(
      () => currentTextId,
      (id) => {
        currentTextId = id;
      },
      () => hasEmittedTextStart,
      (value) => {
        hasEmittedTextStart = value;
      }
    );

    const removeSlice = (text: string, start: number, end: number): string =>
      text.slice(0, start) + text.slice(end);

    const maybeEmitToolInputStart = (
      controller: StreamController,
      callState: StreamingCallState
    ) => {
      if (callState.hasEmittedStart) {
        return;
      }
      const toolName = callState.toolName;
      if (!toolName || toolName.trim().length === 0) {
        return;
      }
      flushText(controller);
      controller.enqueue({
        type: "tool-input-start",
        id: callState.toolCallId,
        toolName,
      });
      callState.hasEmittedStart = true;
    };

    const maybeEmitToolInputProgress = (
      controller: StreamController,
      callState: StreamingCallState
    ) => {
      if (!callState.hasEmittedStart) {
        return;
      }
      const toolName = callState.toolName;
      if (!toolName) {
        return;
      }
      const fullInput = stringifyToolInputWithSchema({
        tools,
        toolName,
        args: callState.args,
      });
      if (fullInput === "{}") {
        return;
      }
      const prefixCandidate = toIncompleteJsonPrefix(fullInput);
      emitPrefixDelta({
        controller,
        id: callState.toolCallId,
        state: callState,
        candidate: prefixCandidate,
      });
    };

    const finalizeCall = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null,
      rawToolCallText: string | null = null
    ): boolean => {
      const resolvedToolName = callState.toolName ?? fallbackToolName;
      if (!resolvedToolName || resolvedToolName.trim().length === 0) {
        const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
        options?.onError?.(
          shouldEmitRaw && rawToolCallText
            ? "Could not resolve Qwen3CoderToolParser tool name for tool call; emitting original text."
            : "Could not resolve Qwen3CoderToolParser tool name for tool call",
          {
            toolCallId: callState.toolCallId,
            toolCall: rawToolCallText,
          }
        );
        if (callState.hasEmittedStart) {
          controller.enqueue({
            type: "tool-input-end",
            id: callState.toolCallId,
          });
        }
        if (shouldEmitRaw && rawToolCallText) {
          flushText(controller, rawToolCallText);
        }
        return false;
      }

      callState.toolName = resolvedToolName;

      maybeEmitToolInputStart(controller, callState);
      maybeEmitToolInputProgress(controller, callState);

      const finalInput = stringifyToolInputWithSchema({
        tools,
        toolName: resolvedToolName,
        args: callState.args,
      });
      emitFinalRemainder({
        controller,
        id: callState.toolCallId,
        state: callState,
        finalFullJson: finalInput,
        onMismatch: options?.onError,
      });
      controller.enqueue({
        type: "tool-input-end",
        id: callState.toolCallId,
      });
      controller.enqueue({
        type: "tool-call",
        toolCallId: callState.toolCallId,
        toolName: resolvedToolName,
        input: finalInput,
      });
      return true;
    };

    const consumeToolNameTag = (
      controller: StreamController,
      callState: StreamingCallState,
      work: string
    ) => {
      if (callState.toolName) {
        return work;
      }
      const match = QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE.exec(work);
      if (!match) {
        return work;
      }
      const value = normalizeXmlTextValue(match[2] ?? "");
      if (value.trim().length > 0) {
        callState.toolName = value;
      }
      const start = match.index ?? 0;
      const nextWork = removeSlice(
        work,
        start,
        start + (match[0]?.length ?? 0)
      );
      maybeEmitToolInputStart(controller, callState);
      return nextWork;
    };

    const consumeParamTags = (
      controller: StreamController,
      callState: StreamingCallState,
      work: string,
      allowEndOfString: boolean
    ) => {
      const lower = work.toLowerCase();
      let index = 0;
      let lastKept = 0;
      let pieces: string[] | null = null;

      while (true) {
        const lt = lower.indexOf("<", index);
        if (lt === -1) {
          break;
        }

        const parsed = parseQwen3CoderToolParserParamTagAt(work, lower, lt, {
          allowEndOfString,
        });
        if (!parsed) {
          index = lt + 1;
          continue;
        }

        if (parsed.kind === "partial") {
          break;
        }

        mergeParamValue(callState.args, parsed.name, parsed.value);
        pieces ??= [];
        pieces.push(work.slice(lastKept, parsed.start));
        lastKept = parsed.end;
        index = parsed.end;
      }

      maybeEmitToolInputStart(controller, callState);
      if (!pieces) {
        return work;
      }
      pieces.push(work.slice(lastKept));
      return pieces.join("");
    };

    const parseCallContent = (
      controller: StreamController,
      callState: StreamingCallState,
      content: string,
      allowEndOfString: boolean
    ): string => {
      let work = content;
      work = consumeToolNameTag(controller, callState, work);
      work = consumeParamTags(controller, callState, work, allowEndOfString);
      maybeEmitToolInputStart(controller, callState);
      maybeEmitToolInputProgress(controller, callState);
      return work;
    };

    // This cache is scoped to createStreamParser (per-stream), so it cannot outlive
    // one stream invocation.
    // It is bounded by the small set of endTagName values {call, function, tool,
    // invoke, tool_call}, so this is effectively ~5 entries max.
    // Eviction is unnecessary because the keyspace is fixed and tiny.
    const closeTagCache = new Map<string, RegExp>();

    const getCloseTagPattern = (endTagName: string): RegExp => {
      const cached = closeTagCache.get(endTagName);
      if (cached) {
        return cached;
      }

      const created = new RegExp(
        `<\\s*\\/\\s*${escapeRegExp(endTagName)}\\s*>`,
        "i"
      );
      closeTagCache.set(endTagName, created);
      return created;
    };

    const getNextCallStartInBuffer = (
      callState: StreamingCallState
    ): number => {
      if (callState.endTagName === "tool_call") {
        return -1;
      }
      const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
        callState.buffer
      );
      return match?.index ?? -1;
    };

    const finalizeStreamingCall = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null,
      remainder: string
    ) => {
      const rawToolCallText =
        remainder.length > 0 && callState.raw.endsWith(remainder)
          ? callState.raw.slice(0, -remainder.length)
          : callState.raw;
      const ok = finalizeCall(
        controller,
        callState,
        fallbackToolName,
        rawToolCallText
      );
      if (ok && toolCall) {
        toolCall.emittedToolCallCount += 1;
      }
    };

    const consumeCallAtNextBoundary = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null,
      nextCallStart: number
    ): { done: true; remainder: string } => {
      const beforeNextCall = callState.buffer.slice(0, nextCallStart);
      const afterNextCall = callState.buffer.slice(nextCallStart);

      callState.buffer = parseCallContent(
        controller,
        callState,
        beforeNextCall,
        true
      );
      finalizeStreamingCall(
        controller,
        callState,
        fallbackToolName,
        afterNextCall
      );
      return { done: true, remainder: afterNextCall };
    };

    const consumeCall = (
      controller: StreamController,
      callState: StreamingCallState,
      incoming: string,
      fallbackToolName: string | null
    ): { done: boolean; remainder: string } => {
      callState.buffer += incoming;
      callState.raw += incoming;

      const closeMatch = getCloseTagPattern(callState.endTagName).exec(
        callState.buffer
      );
      const closeStart = closeMatch?.index ?? -1;
      const nextCallStart = getNextCallStartInBuffer(callState);
      const shouldCloseAtNextBoundary =
        nextCallStart !== -1 &&
        (closeStart === -1 || nextCallStart < closeStart);

      if (shouldCloseAtNextBoundary) {
        return consumeCallAtNextBoundary(
          controller,
          callState,
          fallbackToolName,
          nextCallStart
        );
      }

      if (!closeMatch) {
        callState.buffer = parseCallContent(
          controller,
          callState,
          callState.buffer,
          false
        );
        return { done: false, remainder: "" };
      }

      const closeEnd = closeStart + (closeMatch[0]?.length ?? 0);
      const beforeClose = callState.buffer.slice(0, closeStart);
      const afterClose = callState.buffer.slice(closeEnd);

      parseCallContent(controller, callState, beforeClose, false);
      callState.buffer = "";
      finalizeStreamingCall(
        controller,
        callState,
        fallbackToolName,
        afterClose
      );
      return { done: true, remainder: afterClose };
    };

    const finalizeCallAtFinish = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null
    ): { ok: boolean; trailingText: string } => {
      callState.buffer = parseCallContent(
        controller,
        callState,
        callState.buffer,
        true
      );
      const trailingText = stripLeadingCallCloseTags(callState.buffer);
      callState.buffer = "";
      const ok = finalizeCall(controller, callState, fallbackToolName, null);
      return {
        ok,
        trailingText,
      };
    };

    const flushSafeTextPrefix = (controller: StreamController) => {
      const lower = buffer.toLowerCase();

      const potentialIndices = [
        getPotentialStartIndex(lower, toolCallStartPrefixLower),
        ...implicitCallPrefixesLower.map((prefix) =>
          getPotentialStartIndex(lower, prefix)
        ),
      ].filter((value): value is number => value != null);

      const potentialIndex =
        potentialIndices.length > 0 ? Math.min(...potentialIndices) : null;
      if (potentialIndex == null) {
        if (buffer.length > 0) {
          flushText(controller, buffer);
          buffer = "";
        }
        return;
      }

      if (potentialIndex > 0) {
        flushText(controller, buffer.slice(0, potentialIndex));
        buffer = buffer.slice(potentialIndex);
      }
    };

    const stripLeadingToolCallCloseTagsFromBuffer = () => {
      if (!buffer) {
        return;
      }
      const stripped = stripLeadingToolCallCloseTags(buffer);
      if (stripped !== buffer) {
        buffer = stripped;
      }
    };

    const startToolCallIfPresent = (_controller: StreamController) => {
      if (toolCall) {
        return;
      }

      if (implicitCall) {
        return;
      }

      const lower = buffer.toLowerCase();
      const startIndex = getPotentialStartIndex(
        lower,
        toolCallStartPrefixLower
      );
      if (startIndex == null || startIndex !== 0) {
        return;
      }

      const gtIndex = buffer.indexOf(">");
      if (gtIndex === -1) {
        return;
      }

      const openTag = buffer.slice(0, gtIndex + 1);
      if (!TOOL_CALL_OPEN_RE.test(openTag)) {
        return;
      }

      toolCall = {
        outerOpenTag: openTag,
        outerNameAttr: getAttributeValue(openTag, "name"),
        raw: openTag,
        mode: "unknown",
        innerBuffer: "",
        activeCall: null,
        emittedToolCallCount: 0,
      };

      const remainder = buffer.slice(gtIndex + 1);
      buffer = "";
      if (remainder.length > 0) {
        toolCall.raw += remainder;
        toolCall.innerBuffer += remainder;
      }
    };

    const startImplicitCallIfPresent = (controller: StreamController) => {
      if (toolCall || implicitCall) {
        return;
      }

      const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(buffer);
      const startIndex = match?.index ?? -1;
      const openTag = match?.[0] ?? "";
      const callTagName = (match?.[1] ?? "").toLowerCase();
      if (!match || startIndex !== 0 || !openTag || !callTagName) {
        return;
      }

      const toolNameAttr =
        getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
      const selfClosing =
        QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);

      buffer = buffer.slice(openTag.length);

      const newCall: StreamingCallState = {
        endTagName: callTagName,
        toolCallId: generateToolCallId(),
        toolName: toolNameAttr,
        hasEmittedStart: false,
        emittedInput: "",
        raw: openTag,
        args: {},
        buffer: "",
      };

      if (toolNameAttr) {
        maybeEmitToolInputStart(controller, newCall);
      }

      if (selfClosing) {
        finalizeCall(controller, newCall, toolNameAttr, newCall.raw);
        return;
      }

      implicitCall = newCall;
      implicitCallOpenTag = openTag;
    };

    const processImplicitCall = (controller: StreamController) => {
      while (implicitCall) {
        const callState = implicitCall;
        const { done, remainder } = consumeCall(
          controller,
          callState,
          buffer,
          null
        );
        buffer = "";
        if (!done) {
          return;
        }

        implicitCall = null;
        implicitCallOpenTag = null;
        if (remainder.length > 0) {
          buffer = remainder;
        }

        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
        startToolCallIfPresent(controller);
        if (toolCall) {
          processToolCall(controller);
          return;
        }
        startImplicitCallIfPresent(controller);
      }
    };

    const drainStarts = (controller: StreamController) => {
      while (true) {
        if (toolCall || implicitCall) {
          return;
        }

        const before = buffer;
        startToolCallIfPresent(controller);
        if (toolCall) {
          processToolCall(controller);
          return;
        }

        startImplicitCallIfPresent(controller);
        if (implicitCall) {
          processImplicitCall(controller);
          return;
        }

        if (buffer === before) {
          return;
        }
        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
      }
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream tool-call parsing is a nested state machine.
    const processToolCall = (controller: StreamController) => {
      while (toolCall) {
        if (toolCall.mode === "unknown") {
          const callMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
              toolCall.innerBuffer
            );
          const signalMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
              toolCall.innerBuffer
            );
          if (
            callMatch &&
            (!signalMatch || (callMatch.index ?? 0) < (signalMatch.index ?? 0))
          ) {
            toolCall.mode = "multi";
          } else if (signalMatch) {
            toolCall.mode = "single";
            const activeCall: StreamingCallState = {
              endTagName: "tool_call",
              toolCallId: generateToolCallId(),
              toolName: toolCall.outerNameAttr,
              hasEmittedStart: false,
              emittedInput: "",
              raw: toolCall.outerOpenTag,
              args: {},
              buffer: "",
            };
            toolCall.activeCall = activeCall;
            if (toolCall.outerNameAttr) {
              maybeEmitToolInputStart(controller, activeCall);
            }
          } else {
            return;
          }
        }

        if (toolCall.mode === "single") {
          const callState = toolCall.activeCall;
          if (!callState) {
            return;
          }

          const { done, remainder } = consumeCall(
            controller,
            callState,
            toolCall.innerBuffer,
            toolCall.outerNameAttr
          );
          toolCall.innerBuffer = "";

          if (!done) {
            return;
          }

          toolCall = null;
          if (remainder.length > 0) {
            buffer = remainder + buffer;
          }
          flushSafeTextPrefix(controller);
          startToolCallIfPresent(controller);
          continue;
        }

        if (toolCall.mode === "multi") {
          if (toolCall.activeCall) {
            const callState = toolCall.activeCall;
            const { done, remainder } = consumeCall(
              controller,
              callState,
              toolCall.innerBuffer,
              toolCall.outerNameAttr
            );
            toolCall.innerBuffer = "";

            if (!done) {
              return;
            }

            toolCall.activeCall = null;
            toolCall.innerBuffer = remainder;
            continue;
          }

          const closeMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE.exec(
              toolCall.innerBuffer
            );
          const callOpenMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
              toolCall.innerBuffer
            );

          if (!(closeMatch || callOpenMatch)) {
            return;
          }

          const closeIndex = closeMatch?.index ?? -1;
          const callIndex = callOpenMatch?.index ?? -1;
          const hasClose = closeIndex !== -1;
          const hasCall = callIndex !== -1;

          const chooseClose = hasClose && (!hasCall || closeIndex < callIndex);
          const nextIndex = chooseClose ? closeIndex : callIndex;
          if (nextIndex > 0) {
            toolCall.innerBuffer = toolCall.innerBuffer.slice(nextIndex);
          }

          if (chooseClose) {
            const matchLen = closeMatch?.[0]?.length ?? 0;
            const remainder = toolCall.innerBuffer.slice(matchLen);
            toolCall = null;
            if (remainder.length > 0) {
              buffer = remainder + buffer;
            }
            flushSafeTextPrefix(controller);
            startToolCallIfPresent(controller);
            continue;
          }

          if (!callOpenMatch) {
            return;
          }

          const openTag = callOpenMatch[0] ?? "";
          const callTagName = (callOpenMatch[1] ?? "").toLowerCase();
          const rest = toolCall.innerBuffer.slice(openTag.length);

          const selfClosing =
            QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);
          if (selfClosing) {
            const toolNameAttr =
              getAttributeValue(openTag, "name") ??
              getShorthandValue(openTag) ??
              toolCall.outerNameAttr;
            const immediateCall: StreamingCallState = {
              endTagName: callTagName,
              toolCallId: generateToolCallId(),
              toolName: toolNameAttr,
              hasEmittedStart: false,
              emittedInput: "",
              raw: openTag,
              args: {},
              buffer: "",
            };
            const ok = finalizeCall(
              controller,
              immediateCall,
              toolNameAttr,
              immediateCall.raw
            );
            if (ok) {
              toolCall.emittedToolCallCount += 1;
            }
            toolCall.innerBuffer = rest;
            continue;
          }

          const toolNameAttr =
            getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
          const newCall: StreamingCallState = {
            endTagName: callTagName,
            toolCallId: generateToolCallId(),
            toolName: toolNameAttr,
            hasEmittedStart: false,
            emittedInput: "",
            raw: openTag,
            args: {},
            buffer: "",
          };

          if (toolNameAttr) {
            maybeEmitToolInputStart(controller, newCall);
          }

          toolCall.activeCall = newCall;
          toolCall.innerBuffer = rest;
        }
      }
    };

    const reportUnfinishedToolCallAtFinish = (
      controller: StreamController,
      rawToolCall: string
    ) => {
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      options?.onError?.(
        shouldEmitRaw
          ? "Could not complete streaming Qwen3CoderToolParser XML tool call at finish; emitting original text."
          : "Could not complete streaming Qwen3CoderToolParser XML tool call at finish.",
        { toolCall: rawToolCall }
      );
      if (shouldEmitRaw) {
        flushText(controller, rawToolCall);
      }
    };

    const reportUnfinishedImplicitCallAtFinish = (
      controller: StreamController,
      rawCallText: string
    ) => {
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      options?.onError?.(
        shouldEmitRaw
          ? "Could not complete streaming Qwen3CoderToolParser call block at finish; emitting original text."
          : "Could not complete streaming Qwen3CoderToolParser call block at finish.",
        { toolCall: rawCallText }
      );
      if (shouldEmitRaw) {
        flushText(controller, rawCallText);
      }
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream finish reconciliation is a best-effort state machine cleanup.
    const handleFinish = (controller: StreamController) => {
      if (toolCall) {
        // Process any remaining complete structures first.
        processToolCall(controller);

        if (toolCall) {
          // Best-effort reconciliation on incomplete tool-call markup at finish.
          if (toolCall.mode === "unknown") {
            const callMatch =
              QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
                toolCall.innerBuffer
              );
            const signalMatch =
              QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
                toolCall.innerBuffer
              );
            if (
              callMatch &&
              (!signalMatch ||
                (callMatch.index ?? 0) < (signalMatch.index ?? 0))
            ) {
              toolCall.mode = "multi";
            } else if (signalMatch) {
              toolCall.mode = "single";
              toolCall.activeCall = {
                endTagName: "tool_call",
                toolCallId: generateToolCallId(),
                toolName: toolCall.outerNameAttr,
                hasEmittedStart: false,
                emittedInput: "",
                raw: toolCall.outerOpenTag,
                args: {},
                buffer: "",
              };
            }
          }

          if (toolCall.mode === "single" && toolCall.activeCall) {
            toolCall.activeCall.buffer += toolCall.innerBuffer;
            toolCall.innerBuffer = "";
            const result = finalizeCallAtFinish(
              controller,
              toolCall.activeCall,
              toolCall.outerNameAttr
            );
            if (result.ok) {
              toolCall.emittedToolCallCount += 1;
            }
            const shouldFlushTrailingText =
              result.ok || !shouldEmitRawToolCallTextOnError(options);
            if (shouldFlushTrailingText && result.trailingText.length > 0) {
              flushText(controller, result.trailingText);
            }
            if (!result.ok && toolCall.emittedToolCallCount === 0) {
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw);
            }
          } else if (toolCall.mode === "multi") {
            if (toolCall.activeCall) {
              const result = finalizeCallAtFinish(
                controller,
                toolCall.activeCall,
                toolCall.outerNameAttr
              );
              if (result.ok) {
                toolCall.emittedToolCallCount += 1;
              }
              const shouldFlushTrailingText =
                result.ok || !shouldEmitRawToolCallTextOnError(options);
              if (shouldFlushTrailingText && result.trailingText.length > 0) {
                flushText(controller, result.trailingText);
              }
              if (!result.ok && toolCall.emittedToolCallCount === 0) {
                reportUnfinishedToolCallAtFinish(controller, toolCall.raw);
              }
              toolCall.activeCall = null;
            } else if (toolCall.emittedToolCallCount === 0) {
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw);
            }
          } else {
            reportUnfinishedToolCallAtFinish(controller, toolCall.raw);
          }

          toolCall = null;
        }
      }

      if (implicitCall) {
        const callState = implicitCall;
        const openTag = implicitCallOpenTag;
        implicitCall = null;
        implicitCallOpenTag = null;

        const result = finalizeCallAtFinish(controller, callState, null);
        const shouldFlushTrailingText =
          result.ok || !shouldEmitRawToolCallTextOnError(options);
        if (shouldFlushTrailingText && result.trailingText.length > 0) {
          flushText(controller, result.trailingText);
        }
        if (!result.ok && openTag) {
          reportUnfinishedImplicitCallAtFinish(
            controller,
            callState.raw || openTag + callState.buffer
          );
        }
      } else {
        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
        drainStarts(controller);
      }

      if (buffer.length > 0) {
        flushText(controller, buffer);
        buffer = "";
      }

      flushText(controller);
    };

    const handlePassthroughChunk = (
      controller: StreamController,
      chunk: LanguageModelV3StreamPart
    ) => {
      if (!toolCall && buffer) {
        flushText(controller, buffer);
        buffer = "";
      }
      controller.enqueue(chunk);
    };

    const handleTextDeltaChunk = (
      controller: StreamController,
      delta: string
    ) => {
      if (toolCall) {
        toolCall.raw += delta;
        toolCall.innerBuffer += delta;
        processToolCall(controller);
        return;
      }

      if (implicitCall) {
        const callState = implicitCall;
        const { done, remainder } = consumeCall(
          controller,
          callState,
          delta,
          null
        );
        if (!done) {
          return;
        }
        implicitCall = null;
        implicitCallOpenTag = null;
        if (remainder.length > 0) {
          buffer = remainder + buffer;
        }
        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
        drainStarts(controller);
        return;
      }

      buffer += delta;
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      drainStarts(controller);
    };

    const handleTransformChunk = (
      controller: StreamController,
      chunk: LanguageModelV3StreamPart
    ) => {
      if (chunk.type === "finish") {
        handleFinish(controller);
        controller.enqueue(chunk);
        return;
      }
      if (chunk.type !== "text-delta") {
        handlePassthroughChunk(controller, chunk);
        return;
      }
      const delta = chunk.delta;
      if (!delta) {
        return;
      }
      handleTextDeltaChunk(controller, delta);
    };

    return new TransformStream({
      transform(chunk, controller) {
        handleTransformChunk(controller, chunk);
      },
      flush(controller) {
        handleFinish(controller);
      },
    });
  },
});

export const uiTarsXmlProtocol = qwen3CoderProtocol;

export const Qwen3CoderToolParser = qwen3CoderProtocol;
