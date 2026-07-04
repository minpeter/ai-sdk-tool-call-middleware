import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { unescapeXml } from "../../rxml/utils/helpers";
import { escapeRegExp } from "../utils/regex";

/**
 * Qwen3Coder call-parsing primitives shared by the generate-path parser and
 * the streaming state machine in qwen3coder-protocol.ts: tag scanning,
 * parameter-tag parsing (canonical, nameless, and schema-property variants),
 * malformed call-opener normalization, and tool-name salvage.
 */
export const TOOL_CALL_OPEN_RE = /<tool_call\b[^>]*>/i;
export const TOOL_CALL_CLOSE_RE = /<\/tool_call\s*>/i;
const TOOL_CALL_CLOSE_TRAILING_RE = /<\/tool_call\s*>\s*$/i;
export const TOOL_CALL_BLOCK_RE =
  /<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi;
const LEADING_CALL_CLOSE_TAG_RE =
  /^\s*<\s*\/\s*(?:tool_call|function|call|tool|invoke)\s*>/i;

export const CALL_BLOCK_RE =
  /<(call|function|tool|invoke)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES = new Set([
  "parameter",
  "param",
  "argument",
  "arg",
]);

const QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES = new Set([
  "function",
  "call",
  "tool",
  "invoke",
  "tool_call",
]);

const CALL_SHORTHAND_VALUE_RE =
  /^<\s*(call|function|tool|invoke)\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/<]+))/i;
const NESTED_CALL_SHORTHAND_VALUE_RE =
  /<\s*(?:call|function|tool|invoke)\b\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/<]+))/i;

// Non-global variants for streaming parsing (avoids `lastIndex` state).
export const QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b[^>]*>/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE =
  /<\s*\/\s*tool_call\s*>/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE =
  /<\s*(?!\/)\s*(name|tool_name|parameter|param|argument|arg)\b/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE =
  /<\s*(name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/i;
export const QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE = /\/\s*>$/;
/** Whitespace and complete tag-like tokens only (salvage strictness gate). */
export const SALVAGE_MARKUP_ONLY_TEXT_REGEX = /^\s*(?:<[^<>\n]*>\s*)*$/;

/**
 * Tag names that must never be treated as schema-property parameter tags,
 * because the parser assigns them structural meaning.
 */
const QWEN3CODER_RESERVED_TAG_NAMES = new Set([
  ...QWEN3CODER_TOOL_PARSER_PARAM_TAG_NAMES,
  ...QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES,
  "tool_call",
  "name",
  "tool_name",
]);

/**
 * Builds a lowercase → canonical map of the resolved tool's schema property
 * names. Live models (observed on Qwen2.5 and GLM-4.7) frequently emit
 * parameters as bare property-named tags (`<path>…</path>`) instead of the
 * canonical `<parameter=path>…</parameter>`; matching against the schema keys
 * lets the parser accept that variant without misreading arbitrary markup.
 */
export function buildSchemaParamNameMap(
  toolName: string | null | undefined,
  tools: LanguageModelV4FunctionTool[]
): Map<string, string> | null {
  if (!toolName) {
    return null;
  }
  const tool = tools.find((t) => t.name === toolName);
  const properties = (
    tool?.inputSchema as
      | { properties?: Record<string, unknown> }
      | null
      | undefined
  )?.properties;
  if (!properties || typeof properties !== "object") {
    return null;
  }
  const map = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (!QWEN3CODER_RESERVED_TAG_NAMES.has(lower)) {
      map.set(lower, key);
    }
  }
  return map.size > 0 ? map : null;
}

/**
 * `<function>NAME</function>` — the tool name emitted as element text with an
 * immediate close (observed live on Llama 3.1 8B under the Qwen prompt).
 */
const CALL_NAME_AS_TEXT_VARIANT_RE =
  /^(\s*)<(function|call|tool|invoke)\s*>\s*([A-Za-z_][\w.-]{0,255})\s*<\s*\/\s*\2\s*>/i;

/**
 * `function=NAME>` — the call open tag missing its leading `<` (observed live
 * on GLM-4.7).
 */
const CALL_OPEN_MISSING_LT_VARIANT_RE =
  /^(\s*)(function|call|tool|invoke)\s*=\s*"?([A-Za-z_][\w.-]{0,255})"?\s*>?/i;

/**
 * `NAME` or `NAME>` directly after `<tool_call>` (observed live on GLM-4.7).
 * Only rewritten when NAME exactly matches a declared tool, so ordinary prose
 * inside a tool_call block is never misread as a call opener.
 */
const CALL_OPEN_BARE_NAME_VARIANT_RE =
  /^(\s*)([A-Za-z_][\w.-]{0,255})\s*>?[ \t]*(?=\r?\n|<)/;

/**
 * Rewrites malformed call-open variants at the start of a tool_call body to
 * the canonical `<function=NAME>` form so the regular parse paths can handle
 * them. Returns the input unchanged when no variant matches.
 */
export function normalizeToolCallInnerOpenVariants(
  inner: string,
  tools: LanguageModelV4FunctionTool[]
): string {
  const nameAsText = CALL_NAME_AS_TEXT_VARIANT_RE.exec(inner);
  if (nameAsText) {
    const [full, leading = "", tagName = "function", name = ""] = nameAsText;
    if (name) {
      return `${leading}<${tagName.toLowerCase()}=${name}>${inner.slice(full.length)}`;
    }
  }

  const missingLt = CALL_OPEN_MISSING_LT_VARIANT_RE.exec(inner);
  if (missingLt) {
    const [full, leading = "", tagName = "function", name = ""] = missingLt;
    if (name) {
      return `${leading}<${tagName.toLowerCase()}=${name}>${inner.slice(full.length)}`;
    }
  }

  const bareName = CALL_OPEN_BARE_NAME_VARIANT_RE.exec(inner);
  if (bareName) {
    const [full, leading = "", name = ""] = bareName;
    if (name && tools.some((t) => t.name === name)) {
      return `${leading}<function=${name}>${inner.slice(full.length)}`;
    }
  }

  return inner;
}

/**
 * A tool_call body that could still become the `<function>NAME</function>`
 * name-as-text variant once more chunks arrive: an open call tag, an optional
 * identifier, and an optional partial closing tag. Used to defer streaming
 * mode decisions until the shape is resolved.
 */
const CALL_OPEN_TAG_ONLY_PARTIAL_RE = /^\s*<(?:function|call|tool|invoke)$/i;

const CALL_OPEN_BARE_IDENTIFIER_PARTIAL_RE = /^\s*([A-Za-z_][\w.-]{0,255})>?$/;

const CALL_NAME_AS_TEXT_PARTIAL_RE =
  /^\s*<(?:function|call|tool|invoke)\s*>\s*(?:[A-Za-z_][\w.-]{0,255})?\s*(?:<(?:\s*\/(?:\s*[A-Za-z_]{0,12})?)?)?$/i;

/**
 * A tool_call body that could still become the `function=NAME>` missing-`<`
 * variant once more chunks arrive.
 */
const CALL_OPEN_MISSING_LT_PARTIAL_RE =
  /^\s*(?:function|call|tool|invoke)(?:\s*=\s*"?(?:[A-Za-z_][\w.-]{0,255})?"?)?$/i;

type StreamCallOpenNormalization =
  | { status: "unchanged" }
  | { status: "rewritten"; value: string }
  | { status: "incomplete" };

/**
 * Streaming-safe wrapper around normalizeToolCallInnerOpenVariants: rewrites
 * only when the malformed opener is fully determined, and reports
 * `incomplete` while the buffered prefix could still become one of the
 * variants (so the caller defers its mode decision instead of misparsing).
 */
export function normalizeStreamToolCallInnerOpenVariants(
  inner: string,
  tools: LanguageModelV4FunctionTool[]
): StreamCallOpenNormalization {
  // Incomplete-prefix checks come first: a truncated `function=se…` tail must
  // wait for more chunks rather than be rewritten with a truncated name.
  // `<function` at buffer end is also held: the next character decides between
  // canonical `<function=…>` and the `<function>NAME</function>` variant.
  if (
    CALL_OPEN_TAG_ONLY_PARTIAL_RE.test(inner) ||
    CALL_NAME_AS_TEXT_PARTIAL_RE.test(inner) ||
    CALL_OPEN_MISSING_LT_PARTIAL_RE.test(inner)
  ) {
    return { status: "incomplete" };
  }

  const bareIdentifier = CALL_OPEN_BARE_IDENTIFIER_PARTIAL_RE.exec(inner);
  if (bareIdentifier) {
    const partialName = bareIdentifier[1] ?? "";
    if (tools.some((t) => t.name.startsWith(partialName))) {
      return { status: "incomplete" };
    }
  }

  const rewritten = normalizeToolCallInnerOpenVariants(inner, tools);
  if (rewritten !== inner) {
    return { status: "rewritten", value: rewritten };
  }

  return { status: "unchanged" };
}

/**
 * Tag openers/closers whose partial prefix must never leak into streamed
 * tool-input deltas while the closing markup is still arriving.
 */
const TRAILING_WHITESPACE_RE = /\s+$/u;

const QWEN3CODER_PROGRESS_HOLDBACK_TAG_PREFIXES = [
  "</parameter>",
  "</param>",
  "</argument>",
  "</arg>",
  "</function>",
  "</call>",
  "</tool>",
  "</invoke>",
  "</tool_call>",
  "<parameter=",
  "<param=",
  "<argument=",
  "<arg=",
];

/**
 * Returns the earliest index where the value's tail could be the beginning of
 * one of the candidate tags, or null when the tail cannot start any of them.
 */
function trailingPotentialTagStartIndex(
  lowerValue: string,
  candidates: readonly string[]
): number | null {
  let cut: number | null = null;
  for (const candidate of candidates) {
    const maxLen = Math.min(candidate.length - 1, lowerValue.length);
    for (let len = maxLen; len > 0; len -= 1) {
      if (lowerValue.endsWith(candidate.slice(0, len))) {
        const index = lowerValue.length - len;
        if (cut === null || index < cut) {
          cut = index;
        }
        break;
      }
    }
  }
  return cut;
}

/**
 * Streaming progress deltas must only contain value text that is certain to
 * survive final parsing: a trailing run that could still turn into a closing
 * tag (`</parameter…`) and boundary whitespace (trimmed by
 * normalizeXmlTextValue on the final pass) are held back until resolved.
 */
export function sanitizePartialParamValueForProgress(
  partial: { name: string; value: string } | null,
  extraHoldbackTags: readonly string[]
): { name: string; value: string } | null {
  if (!partial) {
    return null;
  }
  let value = partial.value;
  const cut = trailingPotentialTagStartIndex(value.toLowerCase(), [
    ...QWEN3CODER_PROGRESS_HOLDBACK_TAG_PREFIXES,
    ...extraHoldbackTags,
  ]);
  if (cut !== null) {
    value = value.slice(0, cut);
  }
  value = value.replace(TRAILING_WHITESPACE_RE, "");
  // A trailing lone high surrogate (a chunk boundary split an emoji) would be
  // JSON-escaped now but emitted raw once paired, breaking delta extension.
  const lastCode = value.charCodeAt(value.length - 1);
  if (lastCode >= 0xd8_00 && lastCode <= 0xdb_ff) {
    value = value.slice(0, -1);
  }
  return value === partial.value ? partial : { name: partial.name, value };
}

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

export function stripLeadingToolCallCloseTags(text: string): string {
  let out = text;
  while (true) {
    const start = skipAsciiWhitespace(out, 0);
    const trimmed = out.slice(start);
    const match = TOOL_CALL_CLOSE_RE.exec(trimmed);
    if (match?.index !== 0 || !match[0]) {
      return out;
    }
    out = out.slice(start + match[0].length);
  }
}

export function stripTrailingToolCallCloseTags(text: string): string {
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

function isTagNameBoundaryChar(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    isAsciiWhitespace(ch) ||
    ch === ">" ||
    ch === "/" ||
    ch === "="
  );
}

/**
 * Like `getPotentialStartIndex`, but tag-shape aware: a complete occurrence
 * of the prefix counts only when followed by a valid tag-name boundary, so
 * ordinary text such as `<callback>` or `<toolbar>` does not pin the stream
 * buffer until finish. A trailing partial occurrence is still reported so a
 * real tag split across chunks is never flushed as text prematurely.
 */
export function getPotentialTagStartIndex(
  lower: string,
  prefixLower: string
): number | null {
  let from = 0;
  while (true) {
    const index = lower.indexOf(prefixLower, from);
    if (index === -1) {
      break;
    }
    if (isTagNameBoundaryChar(lower[index + prefixLower.length])) {
      return index;
    }
    from = index + 1;
  }

  // Genuine trailing partial: the buffer tail is a proper prefix of the tag.
  // Scanned directly (longest first) because an earlier boundary-invalid full
  // occurrence (e.g. `<tool_callback>`) must not mask a real partial at the
  // end of the buffer.
  const maxLen = Math.min(prefixLower.length - 1, lower.length);
  for (let len = maxLen; len > 0; len -= 1) {
    if (lower.endsWith(prefixLower.slice(0, len))) {
      return lower.length - len;
    }
  }
  return null;
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

function toSupportedCallEndTagName(
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

function findUnclosedParamBoundaryIndex(
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

  const tagNameLower = tagNameParse.tagNameLower;

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
      const rawProgressValue = text.slice(valueStart);
      return {
        kind: "partial",
        start: startIndex,
        openEnd,
        name: paramName,
        value: rawProgressValue ? normalizeXmlTextValue(rawProgressValue) : "",
      };
    }

    const rawValue = text.slice(valueStart);
    return {
      kind: "match",
      start: startIndex,
      end: text.length,
      name: paramName,
      value: rawValue ? normalizeXmlTextValue(rawValue) : "",
    };
  }

  const rawValue = text.slice(valueStart, boundaryIndex);
  return {
    kind: "match",
    start: startIndex,
    end: boundaryIndex,
    name: paramName,
    value: rawValue ? normalizeXmlTextValue(rawValue) : "",
  };
}

function getOpeningTag(xml: string): string | null {
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

export function getShorthandValue(openTag: string): string | null {
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

export function extractShorthandToolNameFromRaw(
  rawText: string
): string | null {
  const match = NESTED_CALL_SHORTHAND_VALUE_RE.exec(rawText);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? unescapeXml(value) : null;
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

export function mergeParamValue(
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

export function mergeArgsWithPartialParam(
  args: Record<string, unknown>,
  partialParam: { name: string; value: string } | null
): Record<string, unknown> {
  if (!partialParam) {
    return args;
  }

  const existing = args[partialParam.name];
  if (existing === undefined) {
    return {
      ...args,
      [partialParam.name]: partialParam.value,
    };
  }

  if (Array.isArray(existing)) {
    return {
      ...args,
      [partialParam.name]: [...existing, partialParam.value],
    };
  }

  return {
    ...args,
    [partialParam.name]: [existing, partialParam.value],
  };
}

function extractParameters(
  xml: string,
  options?: {
    callEndTagNameLower?: string | null;
    schemaParamNames?: Map<string, string> | null;
  }
): Record<string, unknown> {
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
      callEndTagNameLower: options?.callEndTagNameLower,
      schemaParamNames: options?.schemaParamNames,
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

    if (parsed.kind === "skip") {
      index = parsed.end;
      continue;
    }

    index = (parsed.openEnd ?? lt) + 1;
  }

  return args;
}

export function parseSingleFunctionCallXml(
  xml: string,
  fallbackToolName: string | null,
  tools: LanguageModelV4FunctionTool[]
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
  const callEndTagNameLower = toSupportedCallEndTagName(
    openingTag ? getOpenTagNameLower(openingTag) : null
  );

  if (!toolName || toolName.trim().length === 0) {
    return null;
  }

  return {
    toolName,
    args: extractParameters(xml, {
      callEndTagNameLower,
      schemaParamNames: buildSchemaParamNameMap(toolName, tools),
    }),
  };
}

export function findImplicitCallOpenIndices(lowerText: string): number[] {
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

export function stripLeadingCallCloseTags(text: string): string {
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

export function splitImplicitCallAndTail(
  callBlock: string,
  tools: LanguageModelV4FunctionTool[]
): {
  callContent: string;
  trailingText: string;
} {
  const openingTag = getOpeningTag(callBlock);
  const openingTagName = toSupportedCallEndTagName(
    openingTag ? getOpenTagNameLower(openingTag) : null
  );
  const openingToolName = openingTag
    ? (getAttributeValue(openingTag, "name") ?? getShorthandValue(openingTag))
    : null;
  const schemaParamNames = buildSchemaParamNameMap(openingToolName, tools);
  const lowerCallBlock = callBlock.toLowerCase();
  let consumed = 0;

  if (openingTag) {
    consumed = openingTag.length;
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
        callEndTagNameLower: openingTagName,
        schemaParamNames,
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
  outerNameAttr: string | null,
  tools: LanguageModelV4FunctionTool[]
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  for (const block of blocks) {
    const parsed = parseSingleFunctionCallXml(block, outerNameAttr, tools);
    if (!parsed) {
      return null;
    }
    calls.push(parsed);
  }
  return calls;
}

function parseQwen3CoderToolParserClosedMatches(
  inner: string,
  outerNameAttr: string | null,
  tools: LanguageModelV4FunctionTool[]
):
  | Array<{ toolName: string; args: Record<string, unknown> }>
  | null
  | undefined {
  const callBlockMatches = Array.from(inner.matchAll(CALL_BLOCK_RE));
  if (callBlockMatches.length === 0) {
    return;
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
    outerNameAttr,
    tools
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
  if (trailingBlocks.length === 0) {
    return closedCalls;
  }

  const trailingCalls = parseQwen3CoderToolParserCallBlocks(
    trailingBlocks,
    outerNameAttr,
    tools
  );
  if (!trailingCalls) {
    return closedCalls;
  }

  return closedCalls.concat(trailingCalls);
}

/**
 * Best-effort tool-name salvage regex covering every inner call-tag shape the
 * parser itself accepts in parseSingleFunctionCallXml / parseCallContent:
 *   - <(function|call|tool|invoke)="NAME">       shorthand, double-quoted
 *   - <(function|call|tool|invoke)='NAME'>       shorthand, single-quoted
 *   - <(function|call|tool|invoke)=NAME>         shorthand, bare
 *   - <(function|call|tool|invoke) name="NAME">  attribute, double-quoted
 *   - <(function|call|tool|invoke) name='NAME'>  attribute, single-quoted
 *   - <name>NAME</name>                          child element fallback
 *   - <tool_name>NAME</tool_name>                alternate child element fallback
 *
 * Bare-shorthand char class is `[^\s>/]` — exactly the parser's stop set in
 * parseShorthandValue (L159-165): it breaks on ASCII whitespace, `>`, or `/`
 * only. Quoted and attribute alternations are tried first, so the bare branch
 * is only reached when the value did not open with a quote — making it safe
 * to accept `'`, `"`, and `=` mid-value, matching the parser exactly.
 *
 * Keep this in sync with QWEN3CODER_TOOL_PARSER_CALL_TAG_NAMES and
 * parseShorthandValue's accepted character class.
 */
const QWEN3CODER_TOOL_NAME_SALVAGE_REGEX =
  /<(?:function|call|tool|invoke)(?:\s*=\s*"([^"]+)"|\s*=\s*'([^']+)'|\s*=\s*([^\s>/]+)|\s+name\s*=\s*"([^"]+)"|\s+name\s*=\s*'([^']+)')|<(?:name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:name|tool_name)\s*>/i;

/**
 * @internal exported only so unit tests can exhaustively verify the salvage
 * shape coverage. Not part of the public API.
 */
export function extractQwen3CoderToolNameFromMarkup(
  markup: string
): string | undefined {
  const match = markup.match(QWEN3CODER_TOOL_NAME_SALVAGE_REGEX);
  if (!match) {
    return;
  }
  const name =
    match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
  if (!name) {
    return;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseQwen3CoderToolParserToolCallSegment(
  segment: string,
  tools: LanguageModelV4FunctionTool[]
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const extracted = extractToolCallInnerXml(segment);
  if (!extracted) {
    return null;
  }

  const { outerOpenTag } = extracted;
  const inner = normalizeToolCallInnerOpenVariants(extracted.inner, tools);
  const outerNameAttr = getAttributeValue(outerOpenTag, "name");

  const closedCalls = parseQwen3CoderToolParserClosedMatches(
    inner,
    outerNameAttr,
    tools
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
    return parseQwen3CoderToolParserCallBlocks(
      implicitBlocks,
      outerNameAttr,
      tools
    );
  }

  const single =
    parseSingleFunctionCallXml(inner, outerNameAttr, tools) ??
    parseSingleFunctionCallXml(segment, outerNameAttr, tools);
  if (!single) {
    return null;
  }
  return [single];
}
