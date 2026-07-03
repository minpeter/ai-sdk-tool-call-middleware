import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import {
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
  unescapeXml,
} from "../../rxml/utils/helpers";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateToolCallId } from "../utils/id";
import {
  createFlushTextHandler,
  formatToolsWithPromptTemplate,
} from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import {
  emitFailedToolInputLifecycle,
  emitFinalizedToolInputLifecycle,
  emitToolInputProgressDelta,
  enqueueToolInputEndAndCall,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { TCMProtocol } from "./protocol-interface";
import type { QwenStreamCallState } from "./qwen3coder-stream-call-content";
import { parseCallContent } from "./qwen3coder-stream-call-content";

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
/** Whitespace and complete tag-like tokens only (salvage strictness gate). */
const SALVAGE_MARKUP_ONLY_TEXT_REGEX = /^\s*(?:<[^<>\n]*>\s*)*$/;

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
function buildSchemaParamNameMap(
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

const CALL_OPEN_IDENTIFIER_RE = /^[A-Za-z_][\w.-]{0,255}$/;

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
function normalizeToolCallInnerOpenVariants(
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
function normalizeStreamToolCallInnerOpenVariants(
  inner: string,
  tools: LanguageModelV4FunctionTool[]
): StreamCallOpenNormalization {
  // Incomplete-prefix checks come first: a truncated `function=se…` tail must
  // wait for more chunks rather than be rewritten with a truncated name.
  // `<function` at buffer end is also held: the next character decides between
  // canonical `<function=…>` and the `<function>NAME</function>` variant.
  if (
    /^\s*<(?:function|call|tool|invoke)$/i.test(inner) ||
    CALL_NAME_AS_TEXT_PARTIAL_RE.test(inner) ||
    CALL_OPEN_MISSING_LT_PARTIAL_RE.test(inner)
  ) {
    return { status: "incomplete" };
  }

  const bareIdentifier = /^\s*([A-Za-z_][\w.-]{0,255})>?$/.exec(inner);
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
function sanitizePartialParamValueForProgress(
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
  value = value.replace(/\s+$/u, "");
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

function stripLeadingToolCallCloseTags(text: string): string {
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
function getPotentialTagStartIndex(
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
    lowerText.indexOf("<parameter", valueStart),
    lowerText.indexOf("<param", valueStart),
    lowerText.indexOf("<argument", valueStart),
    lowerText.indexOf("<arg", valueStart),
    callCloseIndex,
    findClosingTagStartWithBoundary(
      lowerText,
      valueStart,
      "tool_call",
      allowEndOfString
    ),
    lowerText.indexOf("<function", valueStart),
  ].filter((index) => index !== -1);

  if (schemaParamNames) {
    for (const nameLower of schemaParamNames.keys()) {
      const index = indexOfTagOpenWithBoundary(lowerText, valueStart, nameLower);
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

function parseQwen3CoderToolParserParamTagAt(
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

function normalizeXmlTextValue(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("<![CDATA[") && out.endsWith("]]>")) {
    out = out.slice("<![CDATA[".length, -"]]>".length).trim();
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

function extractShorthandToolNameFromRaw(rawText: string): string | null {
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

function mergeArgsWithPartialParam(
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

function parseSingleFunctionCallXml(
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

function splitImplicitCallAndTail(
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

function parseQwen3CoderToolParserToolCallSegment(
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

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

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
  lines.push(`    <parameter="${nameAttr}">${text}</parameter>`);
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
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    const args = parseToolCallInput(toolCall.input);
    const lines: string[] = ["<tool_call>"];
    lines.push(
      `  <function="${escapeXmlMinimalAttr(toolCall.toolName, '"')}">`
    );
    appendQwen3CoderToolParserArgs(lines, args);
    lines.push("  </function>");
    lines.push("</tool_call>");
    return lines.join("\n");
  },

  parseGeneratedText({ text, tools, options }) {
    const processedElements: LanguageModelV4Content[] = [];

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
      const parsedCalls = parseQwen3CoderToolParserToolCallSegment(
        segment,
        tools
      );
      if (!parsedCalls) {
        options?.onError?.(
          "Could not process Qwen3CoderToolParser XML tool call; keeping original text.",
          {
            toolCall: fallbackText,
            toolName: extractQwen3CoderToolNameFromMarkup(segment),
            toolCallId: generateToolCallId(),
            dropReason: "malformed-tool-call-body",
          }
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
        {
          toolCall: raw,
          toolName: extractQwen3CoderToolNameFromMarkup(raw),
          toolCallId: generateToolCallId(),
          dropReason: "malformed-tool-call-body",
        }
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
        const { callContent, trailingText } = splitImplicitCallAndTail(
          full,
          tools
        );
        const parsed = parseSingleFunctionCallXml(callContent, null, tools);
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

        const parsed = parseSingleFunctionCallXml(full, null, tools);
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

    const tryParseCallBlocksWithoutWrapper = (): boolean =>
      tryParseCallBlocksWithoutWrapperText(text);

    const tryParseSingleFunctionCall = (): boolean => {
      const lowerText = text.toLowerCase();
      const startIndex = lowerText.indexOf("<function");
      if (startIndex === -1) {
        return false;
      }

      pushText(stripTrailingToolCallCloseTags(text.slice(0, startIndex)));
      const trailing = stripLeadingToolCallCloseTags(text.slice(startIndex));
      const parsed = parseSingleFunctionCallXml(trailing, null, tools);
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

    type StreamingCallState = QwenStreamCallState;

    interface ToolCallContainerState {
      activeCall: StreamingCallState | null;
      emittedToolCallCount: number;
      innerBuffer: string;
      mode: ToolCallMode;
      outerNameAttr: string | null;
      outerOpenTag: string;
      raw: string;
    }

    let buffer = "";
    let toolCall: ToolCallContainerState | null = null;
    let implicitCall: StreamingCallState | null = null;
    let implicitCallOpenTag: string | null = null;
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;

    // Bounded by the tool set: one entry per resolved tool name per stream.
    const schemaParamNameCache = new Map<string, Map<string, string> | null>();
    const getSchemaParamNames = (
      toolName: string | null
    ): Map<string, string> | null => {
      if (!toolName) {
        return null;
      }
      let cached = schemaParamNameCache.get(toolName);
      if (cached === undefined) {
        cached = buildSchemaParamNameMap(toolName, tools);
        schemaParamNameCache.set(toolName, cached);
      }
      return cached;
    };

    const getProgressHoldbackTags = (
      callState: StreamingCallState
    ): string[] => {
      const extra: string[] = [`</${callState.endTagName}>`];
      const schemaParamNames = getSchemaParamNames(callState.toolName);
      if (schemaParamNames) {
        for (const nameLower of schemaParamNames.keys()) {
          extra.push(`<${nameLower}>`, `</${nameLower}>`);
        }
      }
      return extra;
    };

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
      const argsForProgress = mergeArgsWithPartialParam(
        callState.args,
        sanitizePartialParamValueForProgress(
          callState.partialParam,
          getProgressHoldbackTags(callState)
        )
      );
      const fullInput = stringifyToolInputWithSchema({
        tools,
        toolName,
        args: argsForProgress,
      });
      if (fullInput === "{}") {
        return;
      }
      emitToolInputProgressDelta({
        controller,
        id: callState.toolCallId,
        state: callState,
        fullInput,
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
        emitFailedToolInputLifecycle({
          controller,
          id: callState.toolCallId,
          endInput: callState.hasEmittedStart,
          emitRawToolCallTextOnError: shouldEmitRaw,
          rawToolCallText,
          emitRawText: (rawText) => {
            flushText(controller, rawText);
          },
        });
        options?.onError?.(
          shouldEmitRaw && rawToolCallText
            ? "Could not resolve Qwen3CoderToolParser tool name for tool call; emitting original text."
            : "Could not resolve Qwen3CoderToolParser tool name for tool call",
          {
            toolCallId: callState.toolCallId,
            toolCall: rawToolCallText,
            toolName: callState.toolName ?? fallbackToolName ?? undefined,
            dropReason: "unresolved-tool-name",
          }
        );
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
      emitFinalizedToolInputLifecycle({
        controller,
        id: callState.toolCallId,
        state: callState,
        toolName: resolvedToolName,
        finalInput,
        onMismatch: options?.onError,
      });
      return true;
    };

    const parseStreamingCallContent = (
      controller: StreamController,
      callState: StreamingCallState,
      content: string,
      allowEndOfString: boolean
    ): string =>
      parseCallContent({
        callState,
        content,
        allowEndOfString,
        nameTagRe: QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE,
        normalizeXmlTextValue,
        parseParamTagAt: (text, lowerText, startIndex, parseOptions) =>
          parseQwen3CoderToolParserParamTagAt(text, lowerText, startIndex, {
            ...parseOptions,
            schemaParamNames: getSchemaParamNames(callState.toolName),
          }),
        mergeParamValue,
        maybeEmitToolInputStart: () => {
          maybeEmitToolInputStart(controller, callState);
        },
        maybeEmitToolInputProgress: () => {
          maybeEmitToolInputProgress(controller, callState);
        },
      });

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

      callState.buffer = parseStreamingCallContent(
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
        callState.buffer = parseStreamingCallContent(
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

      parseStreamingCallContent(controller, callState, beforeClose, true);
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
      callState.buffer = parseStreamingCallContent(
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
        getPotentialTagStartIndex(lower, toolCallStartPrefixLower),
        ...implicitCallPrefixesLower.map((prefix) =>
          getPotentialTagStartIndex(lower, prefix)
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

    const startToolCallIfPresent = () => {
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

      const inlineToolName =
        getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
      if (!inlineToolName || inlineToolName.trim().length === 0) {
        return;
      }
      const selfClosing =
        QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);

      buffer = buffer.slice(openTag.length);

      const newCall: StreamingCallState = {
        endTagName: callTagName,
        toolCallId: generateToolCallId(),
        toolName: inlineToolName,
        hasEmittedStart: false,
        partialParam: null,
        emittedInput: "",
        raw: openTag,
        args: {},
        buffer: "",
      };

      maybeEmitToolInputStart(controller, newCall);

      if (selfClosing) {
        finalizeCall(controller, newCall, inlineToolName, newCall.raw);
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
        startToolCallIfPresent();
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
        startToolCallIfPresent();
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
          const normalization = normalizeStreamToolCallInnerOpenVariants(
            toolCall.innerBuffer,
            tools
          );
          if (normalization.status === "incomplete") {
            return;
          }
          if (normalization.status === "rewritten") {
            toolCall.innerBuffer = normalization.value;
          }
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
              partialParam: null,
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
          startToolCallIfPresent();
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
            startToolCallIfPresent();
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
              partialParam: null,
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
            partialParam: null,
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

    /**
     * Cross-format salvage before dropping an unfinished tool_call block:
     * some models emit Hermes-style JSON payloads inside `<tool_call>` tags
     * regardless of the Qwen prompt (observed live on LiquidAI LFM2). The
     * shared recovery only fires when the block is nothing but resolvable
     * payloads plus markup remnants.
     */
    const trySalvageForeignFormatCalls = (
      controller: StreamController,
      rawToolCall: string
    ): boolean => {
      const recovered = recoverToolCallFromJsonCandidates(rawToolCall, tools);
      if (!recovered) {
        return false;
      }
      const calls = recovered.filter(
        (part): part is Extract<typeof part, { type: "tool-call" }> =>
          part.type === "tool-call"
      );
      const hasProse = recovered.some(
        (part) =>
          part.type === "text" &&
          !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(part.text)
      );
      if (calls.length === 0 || hasProse) {
        return false;
      }
      for (const call of calls) {
        controller.enqueue({
          type: "tool-input-start",
          id: call.toolCallId,
          toolName: call.toolName,
        });
        if (call.input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: call.toolCallId,
            delta: call.input,
          });
        }
        controller.enqueue({ type: "tool-input-end", id: call.toolCallId });
        controller.enqueue(call);
      }
      return true;
    };

    /**
     * Finish-time backstop: re-run the (variant-tolerant) generate-path parser
     * over the buffered tool_call markup before dropping it. This recovers
     * shapes the incremental state machine cannot stream, e.g. GLM-4.7's
     * `<tool_call>write_file` + schema-property parameter tags.
     */
    const trySalvageXmlToolCallAtFinish = (
      controller: StreamController,
      rawToolCall: string
    ): boolean => {
      const synthetic = TOOL_CALL_CLOSE_RE.test(rawToolCall)
        ? rawToolCall
        : `${rawToolCall}</tool_call>`;
      const calls = parseQwen3CoderToolParserToolCallSegment(synthetic, tools);
      if (!calls || calls.length === 0) {
        return false;
      }
      for (const call of calls) {
        const toolCallId = generateToolCallId();
        const input = stringifyToolInputWithSchema({
          tools,
          toolName: call.toolName,
          args: call.args,
        });
        controller.enqueue({
          type: "tool-input-start",
          id: toolCallId,
          toolName: call.toolName,
        });
        if (input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: toolCallId,
            delta: input,
          });
        }
        enqueueToolInputEndAndCall({
          controller,
          id: toolCallId,
          toolName: call.toolName,
          input,
        });
      }
      return true;
    };

    const reportUnfinishedToolCallAtFinish = (
      controller: StreamController,
      rawToolCall: string,
      metadata: { toolCallId?: string; toolName?: string | null } = {}
    ) => {
      if (trySalvageXmlToolCallAtFinish(controller, rawToolCall)) {
        return;
      }
      if (trySalvageForeignFormatCalls(controller, rawToolCall)) {
        return;
      }
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      const toolName =
        metadata.toolName ?? extractShorthandToolNameFromRaw(rawToolCall);
      options?.onError?.(
        shouldEmitRaw
          ? "Could not complete streaming Qwen3CoderToolParser XML tool call at finish; emitting original text."
          : "Could not complete streaming Qwen3CoderToolParser XML tool call at finish.",
        {
          toolCall: rawToolCall,
          ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
          ...(toolName ? { toolName } : {}),
          dropReason: "unfinished-tool-call",
        }
      );
      if (shouldEmitRaw) {
        flushText(controller, rawToolCall);
      }
    };

    const reportUnfinishedImplicitCallAtFinish = (
      controller: StreamController,
      rawCallText: string,
      callState: StreamingCallState
    ) => {
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      options?.onError?.(
        shouldEmitRaw
          ? "Could not complete streaming Qwen3CoderToolParser call block at finish; emitting original text."
          : "Could not complete streaming Qwen3CoderToolParser call block at finish.",
        {
          toolCall: rawCallText,
          toolCallId: callState.toolCallId,
          ...(callState.toolName ? { toolName: callState.toolName } : {}),
          dropReason: "unfinished-tool-call",
        }
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
            // The stream is over, so force malformed-opener normalization even
            // when the live path deferred it as potentially incomplete.
            toolCall.innerBuffer = normalizeToolCallInnerOpenVariants(
              toolCall.innerBuffer,
              tools
            );
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
                partialParam: null,
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
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                toolCallId: toolCall.activeCall.toolCallId,
                ...(toolCall.activeCall.toolName
                  ? { toolName: toolCall.activeCall.toolName }
                  : {}),
              });
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
                reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                  toolCallId: toolCall.activeCall.toolCallId,
                  ...(toolCall.activeCall.toolName
                    ? { toolName: toolCall.activeCall.toolName }
                    : {}),
                });
              }
              toolCall.activeCall = null;
            } else if (toolCall.emittedToolCallCount === 0) {
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                toolName: toolCall.outerNameAttr,
              });
            }
          } else {
            reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
              toolName: toolCall.outerNameAttr,
            });
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
            callState.raw || openTag + callState.buffer,
            callState
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
      chunk: LanguageModelV4StreamPart
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
      chunk: LanguageModelV4StreamPart
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
